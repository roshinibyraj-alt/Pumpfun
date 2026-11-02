'use strict';

class LearningStore {
  constructor(pool) {
    this.pool = pool;
  }

  async initialize(defaultSettings) {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_learning_samples (
        window_start bigint NOT NULL,
        sampled_at bigint NOT NULL,
        sample jsonb NOT NULL,
        PRIMARY KEY (window_start, sampled_at)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS btc_learning_samples_sampled_at_idx
      ON btc_learning_samples (sampled_at)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_paper_events (
        id bigserial PRIMARY KEY,
        ts bigint NOT NULL,
        window_start bigint,
        event text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS btc_paper_events_ts_idx
      ON btc_paper_events (ts DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_strategy_learning_state (
        singleton_id integer PRIMARY KEY CHECK (singleton_id = 1),
        settings jsonb NOT NULL,
        updated_at bigint NOT NULL,
        last_tuned_window bigint
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_strategy_tuning_runs (
        id bigserial PRIMARY KEY,
        evaluated_at bigint NOT NULL,
        windows_evaluated integer NOT NULL,
        result jsonb NOT NULL
      )
    `);
    await this.pool.query(
      `INSERT INTO btc_strategy_learning_state (singleton_id, settings, updated_at)
       VALUES (1, $1::jsonb, $2)
       ON CONFLICT (singleton_id) DO NOTHING`,
      [JSON.stringify(defaultSettings), Date.now()],
    );
  }

  async recordSample(sample) {
    await this.pool.query(
      `INSERT INTO btc_learning_samples (window_start, sampled_at, sample)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (window_start, sampled_at) DO UPDATE SET sample = EXCLUDED.sample`,
      [sample.windowStart, sample.ts, JSON.stringify(sample)],
    );
  }

  async loadSettings(defaultSettings) {
    const result = await this.pool.query(
      `SELECT settings FROM btc_strategy_learning_state WHERE singleton_id = 1`,
    );
    return { ...defaultSettings, ...(result.rows[0]?.settings ?? {}) };
  }

  async loadPullbackBias() {
    const result = await this.pool.query(
      `SELECT details->>'side' AS side
       FROM btc_paper_events
       WHERE event = 'PULLBACK_BIAS_CHANGED'
         AND details->>'side' IN ('UP', 'DOWN')
         AND details->>'method' IN ('macd-1m-12-26-9-reversal-sweep-v1', 'macd-1m-12-26-9-reversal-sweep-v2')
       ORDER BY id DESC
       LIMIT 1`,
    );
    return result.rows[0]?.side ?? null;
  }

  async recordEvent({ ts, windowStart, event, details }) {
    await this.pool.query(
      `INSERT INTO btc_paper_events (ts, window_start, event, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [ts, windowStart ?? null, event, JSON.stringify(details ?? {})],
    );
  }

  async getCompletedWindows(now, limit = 400) {
    const result = await this.pool.query(
      `SELECT window_start,
              jsonb_agg(sample ORDER BY sampled_at) AS samples
       FROM btc_learning_samples
       WHERE window_start + 300000::bigint <= $1::bigint - 10000::bigint
       GROUP BY window_start
       HAVING COUNT(*) >= 20
           AND MAX(sampled_at) >= window_start + 285000::bigint
       ORDER BY window_start DESC
       LIMIT $2`,
      [now, limit],
    );
    return result.rows.map(row => ({
      windowStart: Number(row.window_start),
      samples: row.samples,
    })).reverse();
  }

  async saveTuning(result, evaluatedAt, lastTunedWindow) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (result.applied) {
        await client.query(
          `UPDATE btc_strategy_learning_state
           SET settings = $1::jsonb, updated_at = $2, last_tuned_window = $3
           WHERE singleton_id = 1`,
          [JSON.stringify(result.settings), evaluatedAt, lastTunedWindow],
        );
      } else {
        await client.query(
          `UPDATE btc_strategy_learning_state
           SET updated_at = $1, last_tuned_window = $2
           WHERE singleton_id = 1`,
          [evaluatedAt, lastTunedWindow],
        );
      }
      await client.query(
        `INSERT INTO btc_strategy_tuning_runs (evaluated_at, windows_evaluated, result)
         VALUES ($1, $2, $3::jsonb)`,
        [evaluatedAt, result.windows ?? 0, JSON.stringify(result)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getState() {
    const [state, counts, runs, events] = await Promise.all([
      this.pool.query(
        `SELECT settings, updated_at, last_tuned_window
         FROM btc_strategy_learning_state WHERE singleton_id = 1`,
      ),
      this.pool.query(
        `SELECT COUNT(DISTINCT window_start)::int AS completed_windows,
                COUNT(*)::int AS samples
         FROM btc_learning_samples
          WHERE window_start + 300000::bigint <= $1::bigint - 10000::bigint`,
        [Date.now()],
      ),
      this.pool.query(
        `SELECT evaluated_at, windows_evaluated, result
         FROM btc_strategy_tuning_runs ORDER BY evaluated_at DESC LIMIT 10`,
      ),
      this.pool.query(
        `SELECT ts, window_start, event, details
         FROM btc_paper_events ORDER BY id DESC LIMIT 50`,
      ),
    ]);
    return {
      settings: state.rows[0]?.settings ?? null,
      updatedAt: state.rows[0] ? Number(state.rows[0].updated_at) : null,
      lastTunedWindow: state.rows[0]?.last_tuned_window == null
        ? null : Number(state.rows[0].last_tuned_window),
      completedWindows: counts.rows[0]?.completed_windows ?? 0,
      sampleCount: counts.rows[0]?.samples ?? 0,
      tuningRuns: runs.rows.map(row => ({
        evaluatedAt: Number(row.evaluated_at),
        windowsEvaluated: row.windows_evaluated,
        result: row.result,
      })),
      recentEvents: events.rows.map(row => ({
        ts: Number(row.ts),
        windowStart: row.window_start == null ? null : Number(row.window_start),
        event: row.event,
        ...row.details,
      })),
    };
  }
}

module.exports = { LearningStore };
