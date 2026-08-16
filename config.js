// ============================================================
// CONFIG — every knob you'd like to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v25 — DUAL LADDER, resting limit orders only):
//
//   BOTH engines (5m and 15m) run the SAME DUAL_LADDER logic:
//     1. As soon as a window opens, place TWO resting buy-limit
//        ladders — one for UP, one for DOWN — immediately, with no
//        waiting / monitoring phase and no entry cutoff. Rungs live
//        until the window closes.
//     2. Each ladder has rungs at LADDER_RUNGS (0.40 down to 0.10);
//        every rung is sized at RUNG_AMOUNT ($10) worth of shares
//        (shares = RUNG_AMOUNT / rung price, filled AT the rung
//        price as a maker fill).
//     3. CROSS-CANCEL RULE: the instant a rung fills on one side,
//        the opposite side's SAME-PRICE rung is cancelled (e.g. UP
//        0.40 fills -> DOWN 0.40 order is cancelled). All other
//        rungs on both ladders stay live and are fully independent.
//     4. At resolution, the winning side pays $1/share; the losing
//        side pays $0. Unfilled rungs were never positions — they
//        simply expire with no cost.
//
//   Max exposure per window: 2 sides x 7 rungs x $10 = $140.
//
//   FEES (per docs.polymarket.com/trading/fees and
//   docs.polymarket.com/programs/maker-rebates):
//     - Everything here is a RESTING (maker) limit fill: makers are
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
  STARTING_BANKROLL: 1000,

  // ---- Ladder ----
  // Buy-limit rungs, highest first. Both engines place one ladder
  // per side at every one of these prices, immediately at window
  // open. Rungs live until the window closes (no cutoff).
  LADDER_RUNGS: [0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10],
  // Notional ($) wagered on EACH rung. shares = RUNG_AMOUNT / price.
  RUNG_AMOUNT: 10,

  // ---- Engines ----
  // Each engine runs on its own window length with its OWN bankroll,
  // current window, and history. Keys ('5m' / '15m') are used
  // everywhere in state and the dashboard.
  ENGINES: {
    '5m': {
      label: '5m',
      STRATEGY: 'DUAL_LADDER',
      WINDOW_MINUTES: 5,
      CAPITAL: 1000, // this engine's starting bankroll (independent)
    },
    '15m': {
      label: '15m',
      STRATEGY: 'DUAL_LADDER',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
    },
  },

  // ---- Fees & rebates (Polymarket docs, Crypto category) ----
  // Taker fee = shares x BASE_TAKER_FEE_RATE x price x (1 - price).
  // Crypto taker fee rate is 0.07; makers are never charged.
  BASE_TAKER_FEE_RATE: 0.07,
  // Maker rebate = 20% of the fee-equivalent (Crypto category).
  // Only resting (maker) fills earn it.
  MAKER_REBATE_RATE: 0.20,
  // true = all ladder fills are modeled as resting maker fills:
  // fee 0, 20% rebate credited. (This strategy ONLY uses resting
  // limit orders, so this should stay true.)
  ENTRY_IS_MAKER: true,

  // ---- Resolution ----
  // Filled rungs ride to resolution. If either side's price is
  // observed at/above RESOLUTION_WIN_THRESHOLD in the last tick
  // sampled before the window closes, that side is declared the
  // winner immediately. Otherwise resolution falls back to polling
  // the real market price after close until it converges past one
  // of these thresholds.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s
  // (150/s) per IP. Polling every 500ms uses a small fraction of
  // that even with two engines x two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
