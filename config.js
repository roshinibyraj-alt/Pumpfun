// ============================================================
// CONFIG — every knob you'd like to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v30 — LEADER, single 15m engine):
//
//   The ONLY live strategy is LEADER: when one side's price DIPS to
//   a trigger level, the bot buys the OPPOSITE (leader) side — the
//   side that did NOT dip — instead of buying the dip.
//
//   1. One 15-minute window engine only (no 5m). Separate demo
//      capital, equity curve, drawdown, and streak per engine.
//   2. Trigger levels at LADDER_RUNGS (0.40 down to 0.10): the first
//      time a side's mid is observed AT OR BELOW a level in a window,
//      the bot places a RESTING buy-limit order on the opposite side
//      at the MIRROR of the dipped level — $0.40 dip -> limit $0.60,
//      $0.35 -> $0.65, ... $0.10 -> $0.90 (50 fixed shares, cost = 50
//      x limit price). Each side+level can trigger at most once per
//      window. No cutoff — triggers stay armed until the window closes.
//   3. FILL CONFIRMATION: fills are NOT assumed. The order is placed
//      and its placement round-trip latency is measured (ms, real
//      Polymarket API call). Only AFTER that latency elapses does the
//      bot check that the price has walked through the order price
//      (leader mid <= limit) — the fill is then confirmed at the
//      limit price as a maker fill. Orders that never walk through
//      expire unfilled at window close (no cost).
//   4. STOP LOSS: while the window is open, any filled entry whose
//      side's mid walks down to LEADER.STOP_LOSS_PRICE (0.50) is sold
//      at 0.50 immediately (realized, no re-entry). Backtest over the
//      last 7 days of 15m windows: leaderSL50 = +$36.0k vs +$20.7k
//      without the stop (the held side that flips usually loses).
//   5. Resolution: winning side pays $1/share, losing side $0. Only
//      still-filled entries settle at resolution — stopped-out entries
//      were already realized when the stop hit.
//
//   Max exposure per window: 2 sides x 7 levels x 50 shares = 700
//   shares, up to 100 x sum(rungs) = $175 at the current level set.
//
//   FEES (per docs.polymarket.com/trading/fees + maker-rebates):
//     - Confirmed fills are RESTING (maker) limit fills: makers are
//       never charged fees, and the crypto maker rebate is 20% of
//       the fee-equivalent, credited on fill.
//     - ENTRY_IS_MAKER=true models exactly that: fee 0, 20% rebate.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix

  // ---- Default capital ----
  // Used when an engine doesn't set its own CAPITAL.
  STARTING_BANKROLL: 2000,

  // ---- Trigger levels ----
  // LEADER: the first time a side's price is observed at or below
  // one of these levels, buy the opposite (leader) side. Highest
  // level first; every side+level can trigger once per window.
  LADDER_RUNGS: [0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10],
  // Shares bought per trigger (fixed, regardless of dollar cost).
  // cost per trigger = RUNG_SHARES x mirror limit (e.g. 50sh @ 0.60 = $30).
  RUNG_SHARES: 50,

  // ---- Leader fill confirmation ----
  // Fills are only confirmed AFTER the price walks through the order
  // price, and only after the measured order-placement latency (a
  // real Polymarket round-trip, logged per trigger). CONFIRM_MS_MIN
  // is the floor below which we still wait before checking walk-through.
  LEADER: {
    CONFIRM_MS_MIN: 300,
    // Stop loss: sell a filled leader entry at this price the moment
    // its side's mid walks down to it. null/undefined = no stop.
    STOP_LOSS_PRICE: 0.50,
  },

  // ---- Engines ----
  // One 15m engine with its own bankroll and history. The 5m engine
  // was removed in v30 — the backtest proved LEADER works on 15m, so
  // it is now the ONLY live strategy.
  ENGINES: {
    '15m': {
      label: '15m',
      STRATEGY: 'LEADER',
      WINDOW_MINUTES: 15,
      CAPITAL: 2000, // this engine's starting bankroll (independent)
    },
  },

  // ---- Fees & rebates (Polymarket docs, Crypto category) ----
  // Taker fee = shares x BASE_TAKER_FEE_RATE x price x (1 - price).
  // Crypto taker fee rate is 0.07; makers are never charged.
  BASE_TAKER_FEE_RATE: 0.07,
  // Maker rebate = 20% of the fee-equivalent (Crypto category).
  // Only resting (maker) fills earn it.
  MAKER_REBATE_RATE: 0.20,
  // true = confirmed leader fills are modeled as resting maker fills:
  // fee 0, 20% rebate credited. (LEADER entries are buy-limits that
  // fill on walk-through, so this stays true.)
  ENTRY_IS_MAKER: true,

  // ---- Resolution ----
  // If either side's price is observed at/above RESOLUTION_WIN_THRESHOLD
  // in the last tick sampled before the window closes, that side is
  // declared the winner immediately. Otherwise resolution falls back
  // to polling the real market price after close until it converges.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Learn / backtest (dashboard "Learn" panel — trading unchanged) ----
  // Replays real Polymarket price history to evaluate LEADER (and the
  // historical ladder variants it replaced) so the dashboard stays
  // honest about what the strategy is worth. WINDOWS: how many PAST
  // windows to fetch per engine on refresh. LEARN_ON_BOOT: refresh
  // learn.json in the background on start.
  LEARN: {
    WINDOWS: { '15m': 48 },
    FIDELITY: 1,
    DEEP_RUNGS: [0.15, 0.10],
    TIME_FILTER_FRACTION: 0.60,
    CAP_RUNGS: 4,
    CAP_TAIL_SHARES: 25,
    TAKE_PROFIT: 0.55,
    LEARN_ON_BOOT: true,
    LEARN_MAX_AGE_MS: 30 * 60 * 1000,
    LEARN_FILE: './learn.json',
  },

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s
  // (150/s) per IP. Polling every 500ms uses a small fraction of
  // that even with one engine x two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
