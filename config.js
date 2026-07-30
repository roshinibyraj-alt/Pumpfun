// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders

  // ---- Bankroll / compounding ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix
  WINDOW_MINUTES: 15, // 15-minute up/down windows

  // ---- Strategy: fair value model ----
  VOL_LOOKBACK_MINUTES: 120, // how many 1-min candles to use for realized vol
  MIN_EDGE_TO_TRADE: 0.06, // model prob vs market price must differ by this much (6%)

  // Only attempt one entry per window, and only within this time-remaining
  // band (in seconds). Too early = thin/unstable market. Too late = no room
  // for the edge to play out and slippage eats it.
  ENTRY_WINDOW_SECONDS_MIN: 300, // don't enter with less than 5 min left
  ENTRY_WINDOW_SECONDS_MAX: 720, // don't enter with more than 12 min left

  // ---- Sizing ----
  KELLY_FRACTION: 0.25, // use 25% of full Kelly — full Kelly is too aggressive
  MAX_POSITION_PCT_OF_BANKROLL: 0.05, // hard cap: never risk more than 5% on one trade
  MIN_STAKE_DOLLARS: 5, // don't bother with dust-sized trades

  // ---- Fees (mirrors your other bots' 0.07 taker assumption) ----
  TAKER_FEE_RATE: 0.0, // demo mode: set to 0 for now so you see pure model edge.
  // Flip to 0.07 once you want to see fee-adjusted demo P&L.

  // ---- Loop timing ----
  POLL_INTERVAL_SECONDS: 20, // how often the bot checks the market

  // ---- Files ----
  STATE_FILE: './state.json',
};
