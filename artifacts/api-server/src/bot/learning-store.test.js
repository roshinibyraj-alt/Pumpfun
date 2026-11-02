'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LearningStore } = require('./btc/learning-store');

test('restores the latest recorded direction without overwriting tuning settings', async () => {
  let query;
  const store = new LearningStore({
    async query(sql) { query = sql; return { rows: [{ side: 'DOWN' }] }; },
  });
  assert.equal(await store.loadPullbackBias(), 'DOWN');
  assert.match(query, /PULLBACK_BIAS_CHANGED/);
  assert.match(query, /ORDER BY id DESC/);
  assert.doesNotMatch(query, /UPDATE|INSERT/);
});

test('learning-store timestamps use 64-bit comparisons for millisecond epochs', async () => {
  const queries = [];
  const store = new LearningStore({
    async query(sql) {
      queries.push(sql);
      return { rows: [{}] };
    },
  });

  await store.getCompletedWindows(Date.now());
  await store.getState();

  const timestampQueries = queries.filter(sql => sql.includes('window_start + 300000'));
  assert.equal(timestampQueries.length, 2);
  assert.ok(timestampQueries.every(sql => sql.includes('$1::bigint - 10000::bigint')));
  assert.ok(queries[0].includes('MAX(sampled_at) >= window_start + 285000::bigint'));
});
