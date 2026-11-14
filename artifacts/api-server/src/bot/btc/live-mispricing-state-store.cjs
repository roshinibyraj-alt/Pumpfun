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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_5m_live_mispricing_history_resets (
        bot_key text NOT NULL,
        request_id text NOT NULL,
        completed_at bigint NOT NULL,
        PRIMARY KEY (bot_key, request_id)
      )
    `);
    await this.pool.query(`
      CREATE OR REPLACE FUNCTION btc_5m_live_mispricing_reset_guard()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $reset_guard$
      DECLARE
        latest_reset_request_id text;
      BEGIN
        SELECT request_id INTO latest_reset_request_id
        FROM btc_5m_live_mispricing_history_resets
        WHERE bot_key = NEW.bot_key
        ORDER BY completed_at DESC, request_id DESC
        LIMIT 1;
        IF latest_reset_request_id IS NOT NULL
          AND NEW.state->>'historyResetRequestId' IS DISTINCT FROM latest_reset_request_id THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $reset_guard$
    `);
    await this.pool.query(`
      DO $create_reset_trigger$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = 'btc_5m_live_mispricing_reset_epoch_guard'
            AND tgrelid = 'btc_5m_live_mispricing_state'::regclass
            AND NOT tgisinternal
        ) THEN
          EXECUTE 'CREATE TRIGGER btc_5m_live_mispricing_reset_epoch_guard
            BEFORE INSERT OR UPDATE ON btc_5m_live_mispricing_state
            FOR EACH ROW
            EXECUTE FUNCTION btc_5m_live_mispricing_reset_guard()';
        END IF;
      END;
      $create_reset_trigger$
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

  async resetHistoryOnce(requestId) {
    const normalizedRequestId = String(requestId ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalizedRequestId)) {
      throw new Error('A valid live BTC history reset request ID is required.');
    }

    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        `INSERT INTO btc_5m_live_mispricing_history_resets
           (bot_key, request_id, completed_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (bot_key, request_id) DO NOTHING
         RETURNING request_id`,
        [LIVE_BOT_KEY, normalizedRequestId, Date.now()],
      );
      if (!claim.rows?.length) {
        await client.query('COMMIT');
        return false;
      }

      await client.query(
        'DELETE FROM btc_5m_live_mispricing_state WHERE bot_key = $1',
        [LIVE_BOT_KEY],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release?.();
    }
  }
}

module.exports = { LiveMispricingStateStore, LIVE_BOT_KEY };
