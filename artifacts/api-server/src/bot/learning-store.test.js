'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearningStore } = require('./btc/learning-store');

test('learning summary only counts samples and windows for the active strategy version', async () => {
  const calls = [];
  const store = new LearningStore({
    async query(sql, params = []) {
      calls.push({ sql, params });
      return {
        rows: sql.includes('btc_learning_samples')
          ? [{ sample_count: '17' }]
          : [{ completed_windows: '3' }],
      };
    },
  });

  const summary = await store.getLearningSummary('btc-5m-renko-1m-signal-tp099-resolution-v1');
  assert.equal(summary.strategyVersion, 'btc-5m-renko-1m-signal-tp099-resolution-v1');
  assert.equal(summary.completedWindows, 3);
  assert.equal(summary.sampleCount, 17);
  assert.equal(summary.tuningEnabled, false);
  assert.ok(calls.every(call => call.params[0] === 'btc-5m-renko-1m-signal-tp099-resolution-v1'));
  assert.ok(calls[0].sql.includes("sample->>'orderStrategy'"));
  assert.ok(calls[1].sql.includes('strategy_version = $1'));
});

test('schema migration preserves existing history while tagging older rows as legacy', async () => {
  const queries = [];
  const store = new LearningStore({
    async query(sql) {
      queries.push(sql);
      return { rows: [] };
    },
  });

  await store.initialize();
  assert.ok(queries.some(sql => sql.includes(
    'ALTER TABLE btc_paper_window_results',
  ) && sql.includes("DEFAULT 'legacy'")));
  assert.ok(queries.some(sql => sql.includes(
    'ALTER TABLE btc_paper_equity_snapshots',
  ) && sql.includes("DEFAULT 'legacy'")));
  assert.equal(queries.some(sql => sql.includes('TRUNCATE TABLE')), false);
  assert.equal(queries.some(sql => sql.includes('btc_strategy_learning_state')), false);
  assert.equal(queries.some(sql => sql.includes('btc_strategy_tuning_runs')), false);
});

test('history reset is one-time and removes only the selected bot ledger', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT 1 FROM btc_paper_history_reset_requests')) return { rows: [] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const store = new LearningStore({ connect: async () => client });

  assert.equal(await store.resetHistoryOnce('paper-reset-test'), true);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /btc_paper_history_reset_requests/);
  assert.deepEqual(calls[1].params, ['btc-5m-price-band', 'paper-reset-test']);
  assert.match(calls[2].sql, /DELETE FROM btc_5m_paper_bot_state/);
  assert.match(calls[3].sql, /INSERT INTO btc_paper_history_reset_requests/);
  assert.equal(calls.some(call => call.sql.includes('TRUNCATE TABLE')), false);
  assert.ok(calls.every(call => !/btc_learning_samples|btc_paper_events|btc_paper_window_results|btc_paper_equity_snapshots/.test(call.sql)));
  assert.equal(calls[4].sql, 'COMMIT');
  assert.equal(calls[5].sql, 'RELEASE');
});

test('a repeated reset request does not clear the bot ledger twice', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT 1 FROM btc_paper_history_reset_requests')) {
        return { rows: [{ one: 1 }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const store = new LearningStore({ connect: async () => client });

  assert.equal(await store.resetHistoryOnce('paper-reset-test'), false);
  assert.equal(calls.length, 4);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.equal(calls[3].sql, 'RELEASE');
});

test('history reset atomically reseeds only the requested BTC paper ledger', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT 1 FROM btc_paper_history_reset_requests')) return { rows: [] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const store = new LearningStore({ connect: async () => client });
  const freshState = {
    schemaVersion: 1,
    startingCapital: 3_000,
    cash: 3_000,
    trades: [],
    events: [],
  };

  assert.equal(await store.resetHistoryOnce('paper-reset-v5', {
    botKey: 'btc-5m-price-band',
    initialState: freshState,
  }), true);

  const deleteCall = calls.find(call => call.sql.includes('DELETE FROM btc_5m_paper_bot_state'));
  const insertCall = calls.find(call => call.sql.includes('INSERT INTO btc_5m_paper_bot_state'));
  assert.deepEqual(deleteCall.params, ['btc-5m-price-band']);
  assert.equal(insertCall.params[0], 'btc-5m-price-band');
  assert.deepEqual(JSON.parse(insertCall.params[1]), {
    ...freshState,
    historyResetRequestId: 'paper-reset-v5',
  });
  assert.equal(calls.some(call => call.sql.includes('TRUNCATE TABLE')), false);
  assert.ok(calls.every(call => !/btc_learning_samples|btc_paper_events|btc_paper_window_results|btc_paper_equity_snapshots/.test(call.sql)));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO btc_paper_history_reset_requests')));
  assert.equal(calls.at(-2).sql, 'COMMIT');
});
