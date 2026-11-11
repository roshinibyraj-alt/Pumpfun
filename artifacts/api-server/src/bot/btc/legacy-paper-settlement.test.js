'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LegacyPaperSettlementWorker } = require('./legacy-paper-settlement.cjs');

function makeState(windowEnd) {
  return {
    cash: 950,
    realizedPnl: -10,
    eventSequence: 7,
    events: [],
    trades: [{
      id: 'trade-8',
      status: 'OPEN',
      settlementStatus: 'OPEN',
      marketId: 'old-market',
      tokenId: 'old-up-token',
      side: 'UP',
      shares: 100,
      totalCost: 50,
      windowEnd,
    }],
  };
}

test('archived positions update the old ledger only after exact-market resolution', async () => {
  const now = 10_000;
  const state = makeState(now - 1);
  let saved = null;
  const worker = new LegacyPaperSettlementWorker({
    now: () => now,
    stateStore: {
      async loadState() { return state; },
      async saveState(value) { saved = structuredClone(value); },
    },
    marketData: {
      async getMarket(id) {
        return {
          id,
          closed: true,
          umaResolutionStatus: 'resolved',
          outcomePrices: '["1","0"]',
          outcomes: '["Up","Down"]',
          clobTokenIds: '["old-up-token","old-down-token"]',
        };
      },
    },
  });
  worker.running = true;
  assert.equal(await worker.runOnce(), true);
  assert.equal(saved.trades[0].status, 'SETTLED');
  assert.equal(saved.trades[0].settlementSource, 'ORIGINAL_MARKET_RESOLUTION');
  assert.equal(saved.cash, 1_050);
  assert.equal(saved.realizedPnl, 40);
  assert.equal(saved.events[0].type, 'LEGACY_POSITION_RESOLVED');
});

test('archived position settlement leaves current and unresolved markets unchanged', async () => {
  const now = 10_000;
  const state = makeState(now + 1);
  let saveCount = 0;
  const worker = new LegacyPaperSettlementWorker({
    now: () => now,
    stateStore: {
      async loadState() { return state; },
      async saveState() { saveCount += 1; },
    },
    marketData: {
      async getMarket(id) {
        return { id, closed: false, umaResolutionStatus: 'proposed' };
      },
    },
  });
  worker.running = true;
  assert.equal(await worker.runOnce(), false);
  assert.equal(state.trades[0].status, 'OPEN');
  assert.equal(saveCount, 0);
});
