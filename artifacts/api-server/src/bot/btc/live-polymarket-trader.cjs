'use strict';

const ACTIVITY_CACHE_MS = 5 * 60_000;
const POSITIONS_MIN_INTERVAL_MS = 15_000;
const POSITIONS_BACKOFF_BASE_MS = 15_000;
const POSITIONS_BACKOFF_MAX_MS = 5 * 60_000;

function retryAfterMs(response, now) {
  const value = response?.headers?.get?.('retry-after');
  if (value == null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

class LivePolymarketTrader {
  constructor(privateKey, {
    sdk = null,
    actions = null,
    privateKeyAdapter = null,
    fetcher = globalThis.fetch,
    clock = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    if (!privateKey) throw new Error('PRIVATE_KEY is required for account access.');
    this.privateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.sdk = sdk;
    this.actions = actions;
    this.privateKeyAdapter = privateKeyAdapter;
    this.fetcher = fetcher;
    this.clock = clock;
    this.sleep = sleep;
    this.client = null;
    this.depositWallet = null;
    this.activityCache = null;
    this.activityCacheAt = 0;
    this.positionsNextAllowedAt = 0;
    this.positionsRequest = null;
    this.positions429Count = 0;
  }

  async authenticate() {
    this.sdk ||= await import('@polymarket/client');
    this.actions ||= await import('@polymarket/client/actions');
    const adapter = this.privateKeyAdapter
      || (await import('@polymarket/client/viem')).privateKey;
    this.client = await this.sdk.createSecureClient({
      signer: adapter(this.privateKey),
    });
    this.depositWallet = this.client.account?.wallet || null;
    if (!this.depositWallet) throw new Error('Polymarket did not resolve the account wallet.');
    return { authenticated: true };
  }

  async placeLimitOrder(tokenId, side, price, size) {
    if (!this.client) throw new Error('Polymarket authentication is not ready.');
    let response;
    try {
      response = await this.client.placeLimitOrder({
        assetId: String(tokenId),
        side: side === 'BUY' ? this.sdk.OrderSide.BUY : this.sdk.OrderSide.SELL,
        price: String(price),
        size: String(size),
        postOnly: false,
      });
    } catch (error) {
      const message = String(error?.message || error);
      const explicitRejection =
        /not enough balance|balance is not enough|insufficient (?:balance|allowance)|invalid token id|(?:invalid|below|lower than|less than).{0,60}(?:minimum|min(?:imum)? size|size)|(?:minimum|min(?:imum)? size|size).{0,60}(?:below|lower than|less than|invalid)/i.test(message);
      error.submissionUncertain = !explicitRejection;
      throw error;
    }
    if (!response?.ok) {
      const error = new Error(response?.message || response?.error || 'Limit order rejected.');
      error.submissionUncertain = false;
      throw error;
    }
    if (!response.orderId) {
      const error = new Error('Polymarket accepted an order without returning its ID.');
      error.submissionUncertain = true;
      throw error;
    }
    return { id: String(response.orderId), status: response.status || 'LIVE' };
  }

  async fetchOrder(orderId) {
    if (!this.client) throw new Error('Polymarket authentication is not ready.');
    const order = await this.client.fetchOrder({ orderId: String(orderId) });
    if (!order?.id) throw new Error(`Polymarket did not return order ${orderId}.`);
    return order;
  }

  async listOpenOrders() {
    if (!this.client) throw new Error('Polymarket authentication is not ready.');
    const orders = [];
    for await (const page of this.client.listOpenOrders()) {
      if (Array.isArray(page?.items)) orders.push(...page.items);
    }
    return orders;
  }

  async cancelOrder(orderId) {
    if (!this.client) throw new Error('Polymarket authentication is not ready.');
    const result = await this.client.cancelOrder({ orderId: String(orderId) });
    const cancelled = Array.isArray(result?.canceled)
      ? result.canceled.map(String)
      : [];
    if (!cancelled.includes(String(orderId))) {
      const reason = result?.notCanceled?.[orderId] || result?.not_canceled?.[orderId];
      throw new Error(reason || `Polymarket did not confirm cancellation for ${orderId}.`);
    }
    return result;
  }

  async getMarket(conditionId) {
    const response = await this.fetcher(
      `https://gamma-api.polymarket.com/markets/${encodeURIComponent(conditionId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw new Error(`Market API returned ${response.status}.`);
    return response.json();
  }

  async getRecentActivity(wallet) {
    const now = Number(this.clock());
    if (this.activityCache && now - this.activityCacheAt < ACTIVITY_CACHE_MS) {
      return this.activityCache;
    }
    const url = new URL('https://data-api.polymarket.com/v2/activity');
    url.searchParams.set('user', wallet);
    url.searchParams.set('limit', '500');
    url.searchParams.set('type', 'TRADE');
    url.searchParams.set('sort_by', 'TIMESTAMP');
    url.searchParams.set('sort_direction', 'DESC');
    const response = await this.fetcher(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Activity API returned ${response.status}.`);
    const payload = await response.json();
    if (!Array.isArray(payload?.data)) {
      throw new Error('Polymarket activity API returned an invalid response.');
    }
    this.activityCache = payload.data;
    this.activityCacheAt = Number(this.clock());
    return this.activityCache;
  }

  async getAllPositions(wallet) {
    if (this.positionsRequest) return this.positionsRequest;
    const now = Number(this.clock());
    const waitMs = Math.max(0, this.positionsNextAllowedAt - now);
    if (waitMs > 0) {
      const error = new Error(`Positions API cooldown is active for ${Math.ceil(waitMs / 1000)}s.`);
      error.rateLimited = true;
      error.retryAfterMs = waitMs;
      throw error;
    }
    this.positionsNextAllowedAt = now + POSITIONS_MIN_INTERVAL_MS;
    const request = this.fetchAllPositions(wallet);
    this.positionsRequest = request;
    try {
      return await request;
    } finally {
      if (this.positionsRequest === request) this.positionsRequest = null;
    }
  }

  async fetchAllPositions(wallet) {
    const pageSize = 500;
    const maxPages = 20;
    const positions = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      if (page > 0) {
        const waitMs = Math.max(0, this.positionsNextAllowedAt - Number(this.clock()));
        if (waitMs > 0) await this.sleep(waitMs);
        this.positionsNextAllowedAt = Number(this.clock()) + POSITIONS_MIN_INTERVAL_MS;
      }
      const url = new URL('https://data-api.polymarket.com/v2/positions');
      url.searchParams.set('user', wallet);
      url.searchParams.set('status', 'OPEN');
      url.searchParams.set('filter_type', 'TOKENS');
      url.searchParams.set('filter_amount', '0.01');
      url.searchParams.set('sort_by', 'TIMESTAMP');
      url.searchParams.set('sort_direction', 'DESC');
      url.searchParams.set('limit', String(pageSize));
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await this.fetcher(url.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        if (response.status === 429) {
          this.positions429Count += 1;
          const serverDelay = retryAfterMs(response, Number(this.clock()));
          const backoff = Math.min(
            POSITIONS_BACKOFF_MAX_MS,
            POSITIONS_BACKOFF_BASE_MS * (2 ** Math.min(this.positions429Count - 1, 5)),
          );
          const retryMs = Math.max(POSITIONS_MIN_INTERVAL_MS, serverDelay, backoff);
          this.positionsNextAllowedAt = Number(this.clock()) + retryMs;
          const error = new Error(`Positions API rate-limited; retry in ${Math.ceil(retryMs / 1000)}s.`);
          error.rateLimited = true;
          error.retryAfterMs = retryMs;
          throw error;
        }
        throw new Error(`Positions API returned ${response.status}.`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.data) || !payload.pagination) {
        throw new Error('Polymarket positions API returned an invalid response.');
      }
      positions.push(...payload.data);
      const nextCursor = payload.pagination.next_cursor;
      if (nextCursor == null || nextCursor === '') {
        this.positions429Count = 0;
        return positions;
      }
      if (typeof nextCursor !== 'string' || nextCursor === cursor) {
        throw new Error('Polymarket positions API returned an invalid cursor.');
      }
      cursor = nextCursor;
    }
    throw new Error(`Positions API exceeded the ${maxPages * pageSize}-row safety limit.`);
  }

  async getEquitySnapshot() {
    if (!this.client) throw new Error('Polymarket authentication is not ready.');
    const wallet = this.depositWallet;
    const [balance, positions, orders, activity] = await Promise.all([
      this.actions.fetchBalanceAllowance(this.client, {
        assetType: this.sdk.AssetType.COLLATERAL,
      }),
      this.getAllPositions(wallet),
      this.listOpenOrders(),
      this.getRecentActivity(wallet),
    ]);
    const collateral = Number(balance?.balance) / 1e6;
    if (!Number.isFinite(collateral)) throw new Error('USDC collateral balance is unavailable.');
    const recentTradeByAsset = new Map();
    for (const trade of activity) {
      const asset = String(trade.token_id || '');
      const timestamp = Number(trade.timestamp);
      if (asset && !recentTradeByAsset.has(asset) && Number.isFinite(timestamp)) {
        recentTradeByAsset.set(asset, new Date(timestamp * 1000).toISOString());
      }
    }
    const normalizedPositions = positions.map(position => ({
      market: String(position.title || position.question || position.market || 'Unknown market'),
      slug: position.slug || null,
      outcome: String(position.outcome || 'Unknown'),
      shares: finite(position.current_size),
      avgEntry: finite(position.avg_price),
      markPrice: finite(position.current_price),
      value: finite(position.current_value),
      pnl: finite(position.unrealized_pnl),
      lastTradeAt: recentTradeByAsset.get(String(position.token_id || '')) || null,
    }));
    const positionValue = normalizedPositions.reduce(
      (sum, position) => sum + (position.value || position.shares * position.markPrice),
      0,
    );
    const transactions = activity.slice(0, 100).map(item => ({
      timestamp: finite(item.timestamp),
      type: String(item.type || 'TRADE'),
      side: String(item.side || ''),
      outcome: String(item.outcome || ''),
      price: finite(item.price),
      shares: finite(item.size),
      amount: finite(item.usdcSize ?? item.usdc_size),
      market: String(item.title || item.question || item.market || ''),
      slug: item.slug || null,
      transactionHash: item.transactionHash || item.transaction_hash || null,
    }));
    return {
      status: 'ready',
      collateral,
      positionValue,
      equity: collateral + positionValue,
      positionCount: normalizedPositions.length,
      positions: normalizedPositions,
      orders,
      transactions,
      asOf: new Date(Number(this.clock())).toISOString(),
    };
  }
}

module.exports = LivePolymarketTrader;
