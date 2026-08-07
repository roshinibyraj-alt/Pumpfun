// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v14 — fixed side pattern + immediate entry, LINEAR
// win/loss staking, no hedge, no candle signal):
//   1. Whenever a new Polymarket UP/DOWN window is detected, the side
//      is picked from BET_PATTERN, cycling one step per window —
//      candles / detectPattern() are NOT consulted at all anymore.
//      Every window trades; nothing is ever skipped as chop/no-signal.
//   2. Entry fires IMMEDIATELY on the first tick the window is seen —
//      no wait, no price trigger condition. It's a genuine TAKER buy
//      at whatever price is showing right then.
//   3. Every entry is sized in DOLLARS, not shares:
//      shares = notional / fillPrice (fractional shares allowed).
//   4. NO take-profit exit — every filled position rides naked all the
//      way to real resolution. A window resolves the instant either
//      side's price is observed at/above RESOLUTION_WIN_THRESHOLD in
//      the LAST tick sampled before the window closes — that side is
//      declared the winner immediately, no waiting on the official
//      market to fully settle. If neither side had cleared the
//      threshold by that last tick, resolution falls back to polling
//      the real market price until it converges.
//   5. Sizing is a LINEAR win/loss ladder, tracked in
//      state.currentBet:
//        - after a LOSS: currentBet += LINEAR_STEP_USD
//        - after a WIN:  currentBet -= LINEAR_STEP_USD, floored at
//          ORDER_NOTIONAL_USD (never goes below the base bet)
//      This is genuinely outcome-dependent (unlike the old alternating
//      base/double toggle, which ignored win/loss entirely). Because
//      resolution of a window must be known before the NEXT window's
//      bet is sized, bot.js resolves any closed window FIRST each
//      tick, before creating the next window or firing its entry —
//      otherwise sizing would lag the true win/loss by one window.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Bankroll ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix
  WINDOW_MINUTES: 5,

  // ---- Side pattern ----
  // Fixed repeating sequence of sides — one step consumed per window,
  // wrapping back to index 0 after the last entry. 'UP' = bet up-side
  // token, 'DOWN' = bet down-side token. NOT derived from candles or
  // any live signal — every window trades this sequence no matter
  // what the market is doing.
  BET_PATTERN: ['UP', 'DOWN', 'UP', 'UP', 'DOWN', 'UP', 'DOWN', 'DOWN'], // U D U U D U D D

  // ---- Entry timing ----
  // No wait, no price trigger: the entry fires immediately, the first
  // tick the window is seen, at whatever price is showing.

  // ---- Position sizing ----
  // Base dollar notional AND floor for the ladder below. shares =
  // notional / fillPrice, computed at fill time.
  ORDER_NOTIONAL_USD: 50,
  // Linear win/loss ladder: after a LOSS, add this much to the next
  // bet; after a WIN, subtract this much (never going below
  // ORDER_NOTIONAL_USD). Tracked in state.currentBet.
  LINEAR_STEP_USD: 50,

  // ---- Fees ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price), TAKERS ONLY.
  // The ENTRY is a genuine taker fill (pays this fee) since it
  // executes immediately rather than resting. There is no maker leg
  // anymore (v12 removed the resting TP sell), so no rebate ever
  // applies.
  BASE_TAKER_FEE_RATE: 0.07, // Crypto category taker fee rate

  // ---- Resolution ----
  // A position rides naked to real resolution — no take-profit exit.
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
  // two tokens checked per tick. The Binance klines call only happens
  // once per NEW window (not every tick), so it stays well within
  // Binance's public rate limits too.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
