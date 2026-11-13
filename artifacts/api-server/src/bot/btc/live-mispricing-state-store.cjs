'use strict';

const LIVE_BOT_KEY = 'btc-5m-live-mispricing';

class LiveMispricingStateStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') {
      throw new Error('A PostgreSQL pool is required for the live bot ledger.');
    }
    this.pool = pool;
    this.durable = true;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_5m_live_mispricing_state (
        bot_key text PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at bigint NOT NULL
      )
    `);
  }

  async loadState() {
    const result = await this.pool.query(
      'SELECT state FROM btc_5m_live_mispricing_state WHERE bot_key = $1',
      [LIVE_BOT_KEY],
    );
    const value = result.rows[0]?.state ?? null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  }

  async saveState(state) {
    await this.pool.query(
      `INSERT INTO btc_5m_live_mispricing_state (bot_key, state, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (bot_key) DO UPDATE SET
         state = EXCLUDED.state,
         updated_at = EXCLUDED.updated_at`,
      [LIVE_BOT_KEY, JSON.stringify(state), Date.now()],
    );
  }
}

module.exports = { LiveMispricingStateStore, LIVE_BOT_KEY };
