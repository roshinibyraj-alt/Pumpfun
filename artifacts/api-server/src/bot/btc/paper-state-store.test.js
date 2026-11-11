'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaperStateStore, stateFromPublicSnapshot } = require('./paper-state-store.cjs');
const { BtcPriceBandBot } = require('./btc-price-band-bot.cjs');

function snapshot(overrides = {}) {
  return {
    mode: 'PAPER ONLY',
    strategy: { version: 'btc-5m-best-ask-change-opposite-reversal-297s-v3' },
    window: { start: 600_000, end: 900_000, terminalObservation: null },
    market: { id: 'btc-market-600' },
    account: {
      startingCapital: 3000,
      cash: 2950,
      realizedPnl: 0,
      openPositions: 1,
      pendingResolutionPositions: 0,
      settledPositions: 0,
      closedPositions: 0,
    },
    trades: [{
      id: 'trade-1',
      marketId: 'btc-market-600',
      side: 'UP',
      shares: 50,
      totalCost: 50,
      status: 'OPEN',
    }],
    events: [{ id: 'event-3', type: 'BUY_FILLED' }],
    sideState: {
      UP: { status: 'BUY_FILLED', lastBestAsk: 0.53 },
      DOWN: { status: 'WAITING' },
    },
    quotes: {
      UP: { bestAsk: 0.53, bestBid: null, updatedAt: 700_000, sourceTimestamp: 700_000 },
      DOWN: { bestAsk: null, bestBid: null, updatedAt: 700_000 },
    },
    ...overrides,
  };
}

test('snapshot import preserves the complete paper ledger and does not treat empty bids as losses', () => {
  const imported = stateFromPublicSnapshot(snapshot());
  assert.equal(imported.schemaVersion, 1);
  assert.equal(imported.cash, 2950);
  assert.equal(imported.trades.length, 1);
  assert.equal(imported.tradeSequence, 1);
  assert.equal(imported.eventSequence, 3);
  assert.equal(imported.terminalEvidence.UP.loserHitAt, null);
  assert.equal(imported.lastAskTrigger.UP.bestAsk, 0.53);
});

test('snapshot import refuses a truncated trade list', () => {
  assert.throws(
    () => stateFromPublicSnapshot(snapshot({
      account: {
        startingCapital: 3000,
        cash: 2950,
        realizedPnl: 0,
        openPositions: 2,
        pendingResolutionPositions: 0,
        settledPositions: 0,
        closedPositions: 0,
      },
    })),
    /trade list is truncated/,
  );
});

test('initial history seed is idempotent and does not overwrite an existing ledger', async () => {
  const rows = new Map();
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('CREATE TABLE')) return { rows: [] };
      if (sql.includes('SELECT state')) {
        const state = rows.get(params[0]);
        return { rows: state ? [{ state }] : [] };
      }
      if (sql.includes('INSERT INTO btc_5m_paper_bot_state')) {
        rows.set(params[0], JSON.parse(params[1]));
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const store = new PaperStateStore(pool);
  await store.initialize();
  const first = await store.seedFromPublicSnapshot(snapshot());
  const second = await store.seedFromPublicSnapshot(snapshot({
    account: { ...snapshot().account, cash: 100 },
  }));

  assert.deepEqual(first, { seeded: true, tradeCount: 1, cash: 2950 });
  assert.deepEqual(second, { seeded: false, reason: 'state-already-present' });
  assert.equal((await store.loadState()).cash, 2950);
});

test('bot restores its ledger and does not rebuy the same ask after reconnecting', () => {
  const savedState = {
    ...stateFromPublicSnapshot(snapshot()),
    quotes: {
      UP: {
        side: 'UP', bestAsk: 0.53, bestBid: 0.5, askSize: 100, bidSize: 100,
        updatedAt: 700_000, sourceTimestamp: 700_000, status: 'LIVE',
      },
      DOWN: null,
    },
  };
  const bot = new BtcPriceBandBot({ now: () => 700_001 });
  bot.restorePersistentState(savedState);
  bot.storageHealthy = true;
  bot.market = {
    id: 'btc-market-600',
    slug: 'btc-updown-5m-600',
    title: 'BTC Up or Down',
    start: 600_000,
    end: 900_000,
    tokens: { UP: 'up-token', DOWN: 'down-token' },
    raw: { feesEnabled: false },
  };

  bot.handleMarketMessage({
    event_type: 'book',
    asset_id: 'up-token',
    timestamp: '700001',
    asks: [{ price: '0.53', size: '100' }],
    bids: [{ price: '0.50', size: '100' }],
  });

  assert.equal(bot.cash, 2950);
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].status, 'OPEN');
});

test('production bot refuses to start a fresh ledger when the durable row is missing', async () => {
  const bot = new BtcPriceBandBot({
    stateStore: {
      async initialize() {},
      async loadState() { return null; },
      async saveState() { throw new Error('Should not create a replacement ledger.'); },
    },
    requirePersistedState: true,
  });

  await bot.start();

  assert.equal(bot.running, false);
  assert.equal(bot.persistenceStatus, 'ERROR');
  assert.match(bot.error, /history storage is unavailable/);
});
