// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v20 — dip-recovery entry, $100 notional, stop loss 0.20):
//   Both engines follow the SAME rule, on their own window length and
//   their own independent bankroll:
//
//   1. MONITOR phase — 5m: first 120 seconds. 15m: first 420 seconds.
//      The bot watches UP and DOWN midpoints continuously and records
//      the LAST moment each side was below DIP_LEVEL (0.50).
//   2. TARGET side — when the monitor phase ends, the side whose most
//      recent dip below 0.50 happened the LATEST wins. If neither side
//      ever dipped below 0.50, no trade this window.
//   3. ENTRY — any time after the monitor phase (after 120s / 420s),
//      once the target side's price comes back to RETURN_LEVEL (0.50),
//      buy BUY_AMOUNT ($100) worth of shares:
//        shares = floor($100 / price), filled at the current mid.
//      One buy per window. If the target never returns to 0.50, no
//      trade.
//   4. STOP LOSS — both windows: if the bought side's price hits
//      STOP_LOSS_LEVEL (0.20), exit at 0.20 and realize the loss.
//      Otherwise the position rides to real resolution (win =
//      $1/share, lose = $0).
//
//   Fees/rebates (per docs.polymarket.com/trading/fees and
//   docs.polymarket.com/programs/maker-rebates):
//     - Crypto category: taker fee rate = 0.07
//     - Makers are never charged fees; taker fee formula is
//       fee = shares x feeRate x price x (1 - price)
//     - Crypto maker rebate = 20% of the fee-equivalent, paid to
//       resting (maker) fills only
//     - ENTRY_IS_MAKER=false (default) models our entries as taker
//       fills at the current mid: fee applies, rebate 0. Flip it to
//       true to model resting maker fills instead: no fee, 20%
//       rebate credited.
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

  // ---- Engines ----
  // Each engine runs on its own window length with its OWN bankroll,
  // current window, and history. Keys ('5m' / '15m') are used
  // everywhere in state and the dashboard.
  ENGINES: {
    '5m': {
      label: '5m',
      WINDOW_MINUTES: 5,
      CAPITAL: 1000, // this engine's starting bankroll (independent)
      // Monitor phase length: watch both sides this long for a dip.
      MONITOR_SECS: 120, // first 2 minutes
      // A side "dipped" while its price is below this level.
      DIP_LEVEL: 0.50,
      // Buy trigger: target side's price comes back to this level
      // any time after the monitor phase.
      RETURN_LEVEL: 0.50,
      // Notional size of the single buy: $100 worth of shares.
      BUY_AMOUNT: 100,
      // Stop loss: if the bought side's price hits this level, exit
      // at this price and realize the loss.
      STOP_LOSS_LEVEL: 0.20,
    },
    '15m': {
      label: '15m',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
      MONITOR_SECS: 420, // first 7 minutes
      DIP_LEVEL: 0.50,
      RETURN_LEVEL: 0.50,
      BUY_AMOUNT: 100,
      STOP_LOSS_LEVEL: 0.20,
    },
  },

  // ---- Fees & rebates (Polymarket docs, Crypto category) ----
  // Taker fee = shares x BASE_TAKER_FEE_RATE x price x (1 - price).
  // Crypto taker fee rate is 0.07; makers are never charged.
  BASE_TAKER_FEE_RATE: 0.07,
  // Maker rebate = 20% of the fee-equivalent (Crypto category).
  // Only resting (maker) fills earn it.
  MAKER_REBATE_RATE: 0.20,
  // false = entries are taker fills at the current mid (pay fee,
  // no rebate). true = entries modeled as maker fills (no fee,
  // 20% rebate credited). Default false.
  ENTRY_IS_MAKER: false,

  // ---- Resolution ----
  // Positions that weren't stopped out ride to real resolution.
  // If either side's price is observed at/above RESOLUTION_WIN_THRESHOLD
  // in the last tick sampled before the window closes, that side is
  // declared the winner immediately. Otherwise resolution falls back
  // to polling the real market price after close until it converges
  // past one of these thresholds.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s (150/s)
  // per IP. Polling every 500ms uses a small fraction of that even with
  // two engines x two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
