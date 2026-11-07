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

  const summary = await store.getLearningSummary('btc-5m-candle-signal-taker-v1');
  assert.equal(summary.strategyVersion, 'btc-5m-candle-signal-taker-v1');
  assert.equal(summary.completedWindows, 3);
  assert.equal(summary.sampleCount, 17);
  assert.equal(summary.tuningEnabled, false);
  assert.ok(calls.every(call => call.params[0] === 'btc-5m-candle-signal-taker-v1'));
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

test('one-time reset remains idempotent and only removes paper history when explicitly requested', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT 1 FROM btc_paper_events')) return { rows: [] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  const store = new LearningStore({ connect: async () => client });

  assert.equal(await store.resetHistoryOnce('paper-reset-test'), true);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[2].sql, /TRUNCATE TABLE/);
  assert.doesNotMatch(calls[2].sql, /btc_strategy_tuning_runs|btc_strategy_learning_state/);
  assert.match(calls[3].sql, /BOT_HISTORY_RESET_COMPLETED/);
  assert.equal(calls[4].sql, 'COMMIT');
  assert.equal(calls[5].sql, 'RELEASE');
});
