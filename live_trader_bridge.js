'use strict';

// Long-lived JSON-lines bridge for the Python bot. Secrets stay in the
// process environment and are never written to stdout or returned in JSON.
if (!globalThis.crypto || typeof globalThis.crypto.subtle === 'undefined') {
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, writable: false, configurable: true });
}

const readline = require('node:readline');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { polygon } = require('viem/chains');
const { ClobClient, AssetType, Side, OrderType } = require('@polymarket/clob-client-v2');
const { RelayClient } = require('@polymarket/builder-relayer-client');

const CLOB_HOST = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const POLL_MS = 150;
const POLL_TIMEOUT_MS = 5000;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

class LiveTrader {
  constructor(privateKey) {
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    this.account = privateKeyToAccount(pk);
    this.wallet = createWalletClient({ account: this.account, chain: polygon, transport: http() });
    this.clob = null;
    this.funderAddress = null;
  }

  async authenticate() {
    try {
      const relayer = new RelayClient('https://relayer-v2.polymarket.com', CHAIN_ID, this.wallet);
      this.funderAddress = await relayer.deriveDepositWalletAddress();
    } catch (error) {
      console.error('deposit wallet derivation unavailable; using EOA signer');
    }

    const temp = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer: this.wallet });
    const creds = await temp.createOrDeriveApiKey();
    this.clob = new ClobClient({
      host: CLOB_HOST,
      chain: CHAIN_ID,
      signer: this.wallet,
      creds,
      ...(this.funderAddress ? { signatureType: 3, funderAddress: this.funderAddress } : {}),
    });
  }

  async balance() {
    const response = await this.clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return number(response?.balance) / 1e6;
  }

  async placeFokBuy(tokenId, amount) {
    let tickSize = '0.01';
    let negRisk = false;
    try { tickSize = (await this.clob.getTickSize(tokenId)) || tickSize; } catch (_) {}
    try { negRisk = (await this.clob.getNegRisk(tokenId)) || false; } catch (_) {}

    // The highest valid price is one tick below 1.00. This removes practical
    // price protection while remaining valid for the market's tick size.
    const maxPrice = Math.max(number(tickSize), 1 - number(tickSize));
    const response = await this.clob.createAndPostMarketOrder(
      { tokenID: tokenId, amount: Number(amount), price: maxPrice, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize, negRisk },
      OrderType.FOK,
    );

    const orderId = response?.orderID || response?.id || null;
    let order = response || {};
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (orderId && Date.now() < deadline) {
      try {
        const latest = await this.clob.getOrder(orderId);
        if (latest) order = { ...order, ...latest };
        const status = String(order.status || response?.status || '').toLowerCase();
    const matchStatus = String(order.match_status || order.matchStatus || response?.match_status || '').toLowerCase();
    const tradeIds = order.tradeIDs || order.tradeIds || order.associate_trades || response?.tradeIDs || response?.tradeIds || [];
    const isFilled = status === 'filled' || status === 'matched' || matchStatus === 'filled' || matchStatus === 'matched' || (Array.isArray(tradeIds) && tradeIds.length > 0);

    // The order price is the worst-price limit, not the realized average.
    // Resolve matched trade records so the dashboard reports actual execution.
    let shares = number(order.size_matched ?? order.filled_size ?? response?.size_matched ?? response?.filled_size, 0);
    let avgPrice = number(order.avg_fill_price ?? order.avgPrice ?? response?.avg_fill_price ?? response?.avgPrice, 0);
    if (isFilled && Array.isArray(tradeIds) && tradeIds.length > 0) {
      let filledShares = 0;
      let filledNotional = 0;
      for (const tradeId of tradeIds) {
        try {
          const trades = await this.clob.getTrades({ id: tradeId }, true);
          for (const trade of trades || []) {
            const size = number(trade.size ?? trade.amount, 0);
            const price = number(trade.price, 0);
            if (size > 0 && price > 0) {
              filledShares += size;
              filledNotional += size * price;
            }
          }
        } catch (_) {}
      }
      if (filledShares > 0) {
        shares = filledShares;
        avgPrice = filledNotional / filledShares;
      }
    }

    return {
      orderId,
      status: status || 'unknown',
      matchStatus,
      isFilled,
      shares,
      avgPrice,
      maxPrice,
      tradeCount: Array.isArray(tradeIds) ? tradeIds.length : 0,
    };
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY is not configured');
  const trader = new LiveTrader(privateKey);
  await trader.authenticate();
  let balance = null;
  try { balance = await trader.balance(); } catch (_) {}
  emit({ type: 'ready', address: trader.account.address, funderAddress: trader.funderAddress, balance });

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const command = JSON.parse(line);
      if (command.action === 'place_fok_buy') {
        emit({ type: 'response', requestId: command.requestId, ok: true, result: await trader.placeFokBuy(command.tokenId, command.amount) });
      } else if (command.action === 'balance') {
        emit({ type: 'response', requestId: command.requestId, ok: true, result: { balance: await trader.balance() } });
      } else if (command.action === 'ping') {
        emit({ type: 'response', requestId: command.requestId, ok: true, result: { ready: true } });
      } else {
        emit({ type: 'response', requestId: command.requestId, ok: false, error: 'unknown action' });
      }
    } catch (error) {
      emit({ type: 'response', requestId: null, ok: false, error: String(error?.message || error) });
    }
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
