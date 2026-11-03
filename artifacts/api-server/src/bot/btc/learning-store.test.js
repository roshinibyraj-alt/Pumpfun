'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearningStore } = require('./learning-store');

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
  assert.doesNotMatch(query, /jsonb_agg\(sample ORDER/);
  assert.doesNotMatch(query, /'macd'|'entryPriceBand'/);
  assert.equal(windows[0].windowStart, 1800000000000);
});
