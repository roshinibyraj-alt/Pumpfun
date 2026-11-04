'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearningStore } = require('./learning-store');

test('paper analytics returns completed-window totals and chronological equity history', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM btc_paper_window_results')) {
        return { rows: [{
          completed: '4', wins: '3', losses: '1', flats: '0', net_pnl: '12.5',
        }] };
      }
      if (sql.includes('FROM btc_paper_equity_snapshots')) {
        return { rows: [
          {
            ts: '1800000030000', account_session_started_at: '1800000000000',
            window_start: '1800000000000', equity: '10012.5', cash: '9500',
            marked_value: '512.5', realized_pnl: '10', unrealized_pnl: '2.5',
          },
          {
            ts: '1800000000000', account_session_started_at: '1800000000000',
            window_start: null, equity: '10000', cash: '10000',
            marked_value: '0', realized_pnl: '0', unrealized_pnl: '0',
          },
        ] };
      }
      return { rows: [] };
    },
  };
  const store = new LearningStore(pool);
  const analytics = await store.getPaperAnalytics(500);

  assert.deepEqual(analytics.windowPerformance, {
    completed: 4, wins: 3, losses: 1, flats: 0, winRate: .75, netPnl: 12.5,
  });
  assert.deepEqual(analytics.equityHistory.map(point => point.equity), [10000, 10012.5]);
  assert.equal(calls.find(call => call.sql.includes('FROM btc_paper_equity_snapshots')).params[0], 500);
});

test('completed-window and equity writes retain their window and account-session keys', async () => {
  const calls = [];
  const store = new LearningStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  });
  await store.recordWindowResult({
    windowStart: 1800000000000,
    windowEnd: 1800000300000,
    completedAt: 1800000305000,
    tradeCount: 2,
    netPnl: -3.25,
    outcome: 'LOSS',
  });
  await store.recordEquitySnapshot({
    ts: 1800000310000,
    accountSessionStartedAt: 1800000000000,
    windowStart: 1800000300000,
    equity: 9996.75,
    cash: 9800,
    markedValue: 196.75,
    realizedPnl: -3.25,
    unrealizedPnl: 0,
  });

  assert.match(calls[0].sql, /ON CONFLICT \(window_start\)/);
  assert.deepEqual(calls[0].params.slice(0, 5), [
    1800000000000, 1800000300000, 1800000305000, 2, -3.25,
  ]);
  assert.match(calls[1].sql, /btc_paper_equity_snapshots/);
  assert.deepEqual(calls[1].params.slice(0, 3), [
    1800000310000, 1800000000000, 1800000300000,
  ]);
});
