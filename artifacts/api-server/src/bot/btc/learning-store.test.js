'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearningStore } = require('./learning-store');

test('one-time history reset clears BTC histories but preserves strategy settings', async () => {
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

  assert.equal(await store.resetHistoryOnce('paper-reset-20261104-001'), true);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /SELECT 1 FROM btc_paper_events/);
  assert.match(calls[2].sql, /TRUNCATE TABLE[\s\S]*btc_learning_samples[\s\S]*btc_paper_events[\s\S]*btc_paper_window_results[\s\S]*btc_paper_equity_snapshots[\s\S]*btc_strategy_tuning_runs/);
  assert.doesNotMatch(calls[2].sql, /btc_strategy_learning_state/);
  assert.match(calls[3].sql, /SET updated_at = \$1, last_tuned_window = NULL/);
  assert.match(calls[4].sql, /BOT_HISTORY_RESET_COMPLETED/);
  assert.equal(typeof calls[4].params[0], 'number');
  assert.equal(calls[4].params[1], JSON.stringify({ requestId: 'paper-reset-20261104-001' }));
  assert.equal(calls[5].sql, 'COMMIT');
  assert.equal(calls[6].sql, 'RELEASE');
});

test('the same history reset request is idempotent', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT 1 FROM btc_paper_events')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    release() {},
  };
  const store = new LearningStore({ connect: async () => client });

  assert.equal(await store.resetHistoryOnce('paper-reset-20261104-001'), false);
  assert.equal(calls.some(call => call.sql.includes('TRUNCATE TABLE')), false);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /SELECT 1 FROM btc_paper_events/);
  assert.equal(calls[2].sql, 'COMMIT');
  assert.deepEqual(calls[1].params, ['paper-reset-20261104-001']);
});

test('reset marker cleanup removes only the one-time reset event', async () => {
  const calls = [];
  const store = new LearningStore({
    async query(sql) { calls.push(sql); return { rows: [] }; },
  });
  await store.clearHistoryResetMarkers();
  assert.match(calls[0], /DELETE FROM btc_paper_events WHERE event = 'BOT_HISTORY_RESET_COMPLETED'/);
});

test('historical reads select windows before aggregating and project bounded book depth', async () => {
  let query, parameters;
  const store = new LearningStore({ query: async (sql, values) => {
    query = sql; parameters = values;
    return { rows: [{ window_start: '1800000000000', samples: [] }] };
  } });
  const windows = await store.getCompletedWindows(1800000600000, 99999);
  assert.deepEqual(parameters, [1800000600000, 120]);
  assert.match(query, /selected AS MATERIALIZED/);
  assert.match(query, /JOIN selected USING/);
  assert.match(query, /jsonb_path_query_array/);
  assert.match(query, /\[0 to 19\]/);
  assert.match(query, /'rsi', s\.sample->'rsi'/);
  assert.match(query, /'macd', s\.sample->'macd'/);
  assert.match(query, /'technicalSignal', s\.sample->'technicalSignal'/);
  assert.match(query, /'entryPriceBand', s\.sample->'entryPriceBand'/);
  assert.doesNotMatch(query, /jsonb_agg\(sample ORDER/);
  assert.equal(windows[0].windowStart, 1800000000000);
});
