'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LiveMispricingStateStore,
  LIVE_BOT_KEY,
} = require('./live-mispricing-state-store.cjs');

function createPool() {
  const statements = [];
  const resetRequests = new Set();
  const client = {
    async query(sql, parameters = []) {
      const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalizedSql, parameters });
      if (normalizedSql.startsWith('INSERT INTO btc_5m_live_mispricing_history_resets')) {
        const requestKey = `${parameters[0]}:${parameters[1]}`;
        if (resetRequests.has(requestKey)) return { rows: [], rowCount: 0 };
        resetRequests.add(requestKey);
        return { rows: [{ request_id: parameters[1] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    statements,
    async query(sql, parameters = []) {
      statements.push({
        sql: String(sql).replace(/\s+/g, ' ').trim(),
        parameters,
      });
      return { rows: [], rowCount: 0 };
    },
    async connect() { return client; },
  };
}

test('live history reset clears only its ledger and is idempotent', async () => {
  const pool = createPool();
  const store = new LiveMispricingStateStore(pool);

  assert.equal(await store.resetHistoryOnce('live-reset-once'), true);
  assert.equal(await store.resetHistoryOnce('live-reset-once'), false);

  const deletes = pool.statements.filter(({ sql }) =>
    sql === 'DELETE FROM btc_5m_live_mispricing_state WHERE bot_key = $1');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].parameters, [LIVE_BOT_KEY]);
  const triggerCreation = pool.statements.findIndex(({ sql }) =>
    sql.includes('CREATE TRIGGER btc_5m_live_mispricing_reset_epoch_guard'));
  const historyDeletion = pool.statements.findIndex(({ sql }) =>
    sql === 'DELETE FROM btc_5m_live_mispricing_state WHERE bot_key = $1');
  assert.ok(triggerCreation >= 0 && triggerCreation < historyDeletion);
});

test('live history reset rejects invalid request IDs before touching storage', async () => {
  const pool = createPool();
  const store = new LiveMispricingStateStore(pool);

  await assert.rejects(
    store.resetHistoryOnce('invalid request ID'),
    /valid live BTC history reset request ID/,
  );
  assert.equal(pool.statements.length, 0);
});
