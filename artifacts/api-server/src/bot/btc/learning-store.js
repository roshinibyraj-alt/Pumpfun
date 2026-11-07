'use strict';

class LearningStore {
  constructor(pool) {
    this.pool = pool;
  }

  async initialize() {
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
      CREATE TABLE IF NOT EXISTS btc_paper_window_results (
        window_start bigint PRIMARY KEY,
        window_end bigint NOT NULL,
        completed_at bigint NOT NULL,
        trade_count integer NOT NULL,
        net_pnl double precision NOT NULL,
        outcome text NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'FLAT')),
        strategy_version text NOT NULL DEFAULT 'legacy'
      )
    `);
    await this.pool.query(
      `ALTER TABLE btc_paper_window_results
       ADD COLUMN IF NOT EXISTS strategy_version text NOT NULL DEFAULT 'legacy'`,
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS btc_paper_equity_snapshots (
        id bigserial PRIMARY KEY,
        ts bigint NOT NULL,
        account_session_started_at bigint NOT NULL,
        window_start bigint,
        equity double precision NOT NULL,
        cash double precision NOT NULL,
        marked_value double precision NOT NULL,
        realized_pnl double precision NOT NULL,
        unrealized_pnl double precision NOT NULL,
        strategy_version text NOT NULL DEFAULT 'legacy'
      )
    `);
    await this.pool.query(
      `ALTER TABLE btc_paper_equity_snapshots
       ADD COLUMN IF NOT EXISTS strategy_version text NOT NULL DEFAULT 'legacy'`,
    );
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS btc_paper_equity_snapshots_ts_idx
      ON btc_paper_equity_snapshots (ts DESC)
    `);
  }

  async resetHistoryOnce(requestId) {
    const normalizedRequestId = String(requestId ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalizedRequestId)) {
      throw new Error('A valid BTC history reset request ID is required.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const previousReset = await client.query(
        `SELECT 1 FROM btc_paper_events
         WHERE event = 'BOT_HISTORY_RESET_COMPLETED'
           AND details->>'requestId' = $1
         LIMIT 1`,
        [normalizedRequestId],
      );
      if (previousReset.rows.length) {
        await client.query('COMMIT');
        return false;
      }

      await client.query(`
        TRUNCATE TABLE
          btc_learning_samples,
          btc_paper_events,
          btc_paper_window_results,
          btc_paper_equity_snapshots
        RESTART IDENTITY
      `);
      await client.query(
        `INSERT INTO btc_paper_events (ts, window_start, event, details)
         VALUES ($1, NULL, 'BOT_HISTORY_RESET_COMPLETED', $2::jsonb)`,
        [Date.now(), JSON.stringify({ requestId: normalizedRequestId })],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async clearHistoryResetMarkers() {
    await this.pool.query(
      `DELETE FROM btc_paper_events WHERE event = 'BOT_HISTORY_RESET_COMPLETED'`,
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

  async recordEvent({ ts, windowStart, event, details }) {
    await this.pool.query(
      `INSERT INTO btc_paper_events (ts, window_start, event, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [ts, windowStart ?? null, event, JSON.stringify(details ?? {})],
    );
  }

  async recordWindowResult(result) {
    await this.pool.query(
      `INSERT INTO btc_paper_window_results
         (window_start, window_end, completed_at, trade_count, net_pnl, outcome, strategy_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (window_start) DO UPDATE SET
         window_end = EXCLUDED.window_end,
         completed_at = EXCLUDED.completed_at,
         trade_count = EXCLUDED.trade_count,
         net_pnl = EXCLUDED.net_pnl,
         outcome = EXCLUDED.outcome,
         strategy_version = EXCLUDED.strategy_version`,
      [
        result.windowStart,
        result.windowEnd,
        result.completedAt,
        result.tradeCount,
        result.netPnl,
        result.outcome,
        result.strategyVersion ?? 'legacy',
      ],
    );
  }

  async recordEquitySnapshot(snapshot) {
    await this.pool.query(
      `INSERT INTO btc_paper_equity_snapshots
         (ts, account_session_started_at, window_start, equity, cash,
          marked_value, realized_pnl, unrealized_pnl, strategy_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        snapshot.ts,
        snapshot.accountSessionStartedAt,
        snapshot.windowStart,
        snapshot.equity,
        snapshot.cash,
        snapshot.markedValue,
        snapshot.realizedPnl,
        snapshot.unrealizedPnl,
        snapshot.strategyVersion ?? 'legacy',
      ],
    );
  }

  async getPaperAnalytics(limit = 1000, strategyVersion = 'btc-5m-candle-signal-taker-v1') {
    const boundedLimit = Number.isInteger(limit) ? Math.min(1200, Math.max(50, limit)) : 1000;
    const [performance, equity] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS completed,
                COUNT(*) FILTER (WHERE net_pnl > 0)::int AS wins,
                COUNT(*) FILTER (WHERE net_pnl < 0)::int AS losses,
                COUNT(*) FILTER (WHERE net_pnl = 0)::int AS flats,
                COALESCE(SUM(net_pnl), 0)::double precision AS net_pnl
         FROM btc_paper_window_results
         WHERE strategy_version = $1`,
        [strategyVersion],
      ),
      this.pool.query(
        `SELECT ts, account_session_started_at, window_start, equity, cash,
                marked_value, realized_pnl, unrealized_pnl
         FROM btc_paper_equity_snapshots
         WHERE strategy_version = $2
         ORDER BY ts DESC, id DESC LIMIT $1`,
        [boundedLimit, strategyVersion],
      ),
    ]);
    const row = performance.rows[0] ?? {};
    const completed = Number(row.completed ?? 0);
    const wins = Number(row.wins ?? 0);
    return {
      strategyVersion,
      historyScope: 'current-strategy-version',
      windowPerformance: {
        completed,
        wins,
        losses: Number(row.losses ?? 0),
        flats: Number(row.flats ?? 0),
        winRate: completed ? wins / completed : null,
        netPnl: Number(row.net_pnl ?? 0),
      },
      equityHistory: equity.rows.reverse().map(item => ({
        ts: Number(item.ts),
        accountSessionStartedAt: Number(item.account_session_started_at),
        windowStart: item.window_start == null ? null : Number(item.window_start),
        equity: Number(item.equity),
        cash: Number(item.cash),
        markedValue: Number(item.marked_value),
        realizedPnl: Number(item.realized_pnl),
        unrealizedPnl: Number(item.unrealized_pnl),
      })),
    };
  }

  async getLearningSummary(strategyVersion) {
    const [samples, windows] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::int AS sample_count
         FROM btc_learning_samples
         WHERE sample->>'orderStrategy' = $1`,
        [strategyVersion],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS completed_windows
         FROM btc_paper_window_results
         WHERE strategy_version = $1`,
        [strategyVersion],
      ),
    ]);
    return {
      strategyVersion,
      mode: 'fixed-candle-signal-taker-logging-only',
      tuningEnabled: false,
      sampleCount: Number(samples.rows[0]?.sample_count ?? 0),
      completedWindows: Number(windows.rows[0]?.completed_windows ?? 0),
    };
  }
}

module.exports = { LearningStore };
