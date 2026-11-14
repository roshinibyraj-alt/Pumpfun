'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LivePolymarketTrader = require('./live-polymarket-trader.cjs');

test('account snapshot exposes collateral, marked positions, and recent real trade activity', async () => {
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: { AssetType: { COLLATERAL: 'COLLATERAL' } },
    actions: {
      async fetchBalanceAllowance() {
        return { balance: '123450000' };
      },
    },
    clock: () => 1_800_000_000_000,
  });
  trader.client = {};
  trader.depositWallet = '0xpublic-wallet';
  trader.getAllPositions = async () => [{
    title: 'BTC Up or Down',
    slug: 'btc-updown-5m-123',
    outcome: 'Up',
    current_size: '10',
    avg_price: '0.42',
    current_price: '0.51',
    current_value: '5.10',
    unrealized_pnl: '0.90',
    token_id: 'public-token-id',
  }];
  trader.listOpenOrders = async () => [{ id: 'public-order-id' }];
  trader.getRecentActivity = async () => [{
    timestamp: 1_799_999_900,
    type: 'TRADE',
    side: 'BUY',
    outcome: 'Up',
    price: '0.42',
    size: '10',
    usdcSize: '4.20',
    title: 'BTC Up or Down',
    slug: 'btc-updown-5m-123',
    transactionHash: '0xpublic-transaction-hash',
    proxyWallet: 'must-not-be-returned',
  }];

  const snapshot = await trader.getEquitySnapshot();
  assert.equal(snapshot.collateral, 123.45);
  assert.equal(snapshot.positionValue, 5.1);
  assert.equal(snapshot.equity, 128.55);
  assert.equal(snapshot.positions[0].shares, 10);
  assert.equal(snapshot.transactions[0].amount, 4.2);
  assert.equal(snapshot.transactions[0].transactionHash, '0xpublic-transaction-hash');
  assert.equal(Object.hasOwn(snapshot.transactions[0], 'proxyWallet'), false);
});

test('fresh CLOB order snapshots remain available while dashboard positions are rate-limited', async () => {
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: { AssetType: { COLLATERAL: 'COLLATERAL' } },
    actions: {
      async fetchBalanceAllowance() {
        return { balance: '123450000' };
      },
    },
    clock: () => 1_800_000_000_000,
  });
  trader.client = {};
  trader.depositWallet = '0xpublic-wallet';
  let positionReads = 0;
  trader.listOpenOrders = async () => [];
  trader.getAllPositions = async () => {
    positionReads += 1;
    const error = new Error('Positions API rate-limited; retry in 30s.');
    error.rateLimited = true;
    error.httpStatus = 429;
    error.retryAfterMs = 30_000;
    throw error;
  };
  trader.getRecentActivity = async () => [];

  const trading = await trader.getTradingSnapshot();
  assert.equal(positionReads, 0);
  assert.equal(trading.accountReady, true);
  assert.equal(trading.orderSnapshotStatus, 'READY');
  assert.deepEqual(trading.orders, []);

  const display = await trader.refreshDisplaySnapshot();
  assert.equal(display.positionsStatus, 'RATE_LIMITED');
  assert.equal(display.positionsHttpStatus, 429);
  assert.equal(display.positionsRetryAfterMs, 30_000);
  assert.equal(trading.orderSnapshotStatus, 'READY');
});

test('a local positions cooldown is not reported as an upstream rate limit', async () => {
  let fetches = 0;
  const trader = new LivePolymarketTrader('test-private-key', {
    fetcher: async () => {
      fetches += 1;
      throw new Error('Fetch should not run during local cooldown.');
    },
    clock: () => 20_000,
  });
  trader.positionsNextAllowedAt = 50_000;

  await assert.rejects(
    trader.getAllPositions('0xpublic-wallet'),
    error => {
      assert.equal(error.cooldown, true);
      assert.equal(error.rateLimited, undefined);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test('upstream positions 429 exposes its HTTP status and retry delay', async () => {
  const trader = new LivePolymarketTrader('test-private-key', {
    fetcher: async () => ({
      ok: false,
      status: 429,
      headers: { get: name => name.toLowerCase() === 'retry-after' ? '2' : null },
    }),
    clock: () => 20_000,
  });

  await assert.rejects(
    trader.getAllPositions('0xpublic-wallet'),
    error => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.cooldown, undefined);
      assert.equal(error.httpStatus, 429);
      assert.equal(error.retryAfterMs, 15_000);
      return true;
    },
  );
});

test('taker orders preserve share sizing and post as immediate FAK orders', async () => {
  let created;
  let posted;
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: {
      OrderSide: { BUY: 'BUY_SIDE', SELL: 'SELL_SIDE' },
      OrderType: { FAK: 'FAK_TYPE' },
    },
  });
  trader.client = {
    async createLimitOrder(request) {
      created = request;
      return { ...request, orderType: 'GTC_TYPE' };
    },
    async postOrder(order) {
      posted = order;
      return { ok: true, orderId: 'taker-order-1', status: 'MATCHED' };
    },
  };

  const response = await trader.placeTakerOrder('token-1', 'BUY', 0.99, 14);

  assert.equal(created.assetId, 'token-1');
  assert.equal(created.side, 'BUY_SIDE');
  assert.equal(created.price, '0.99');
  assert.equal(created.size, '14');
  assert.equal(created.postOnly, false);
  assert.equal(posted.orderType, 'FAK_TYPE');
  assert.equal(posted.postOnly, false);
  assert.equal(response.id, 'taker-order-1');
  assert.equal(response.status, 'MATCHED');
});

test('USD-sized FAK buys enforce both the notional stake and all-in spend cap', async () => {
  let created;
  let posted;
  const trader = new LivePolymarketTrader('test-private-key', {
    sdk: {
      OrderSide: { BUY: 'BUY_SIDE', SELL: 'SELL_SIDE' },
      OrderType: { FAK: 'FAK_TYPE' },
    },
  });
  trader.client = {
    async createMarketOrder(request) {
      created = request;
      return { ...request, orderType: 'GTC_TYPE' };
    },
    async postOrder(order) {
      posted = order;
      return { ok: true, orderId: 'usd-taker-order-1', status: 'MATCHED' };
    },
  };

  const response = await trader.placeTakerBuyByUsd('token-1', 5, 5, 0.99);

  assert.equal(created.assetId, 'token-1');
  assert.equal(created.side, 'BUY_SIDE');
  assert.equal(created.amount, '5');
  assert.equal(created.maxSpend, '5');
  assert.equal(created.maxPrice, '0.99');
  assert.equal(created.orderType, 'FAK_TYPE');
  assert.equal(posted.orderType, 'FAK_TYPE');
  assert.equal(response.id, 'usd-taker-order-1');
  assert.equal(response.status, 'MATCHED');
});
