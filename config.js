// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders

  // Live results (see the trade log) showed the "fade the market" model
  // losing badly: on the 29/34 trades where the model disagreed with
  // Polymarket's own price, the market's favored side was actually right
  // 79% of the time. That's strong evidence the model has no real edge
  // over these markets. Real staking is paused here while SHADOW_MODE
  // collects a much larger, zero-cost sample to check whether that holds
  // up statistically before risking demo money again.
  TRADING_ENABLED: false,

  // When true, every window is evaluated and logged (model vs market vs
  // actual outcome) whether or not TRADING_ENABLED would have staked on
  // it. This is how we validate the strategy going forward, since
  // Polymarket's own historical CLOB data isn't usable for backtesting
  // these markets (see SHADOW_MODE note in bot.js).
  SHADOW_MODE: true,

  // ---- Bankroll / compounding ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix
  WINDOW_MINUTES: 5, // Polymarket also runs 5-min BTC up/down markets
  // (slug: btc-updown-5m-{timestamp}, launched Feb 2026) — switched from
  // 15 to get through the shadow-validation sample ~3x faster (288
  // windows/day instead of 96).

  // ---- Strategy: fair value model ----
  VOL_LOOKBACK_MINUTES: 120, // how many 1-min candles to use for realized vol
  MIN_EDGE_TO_TRADE: 0.06, // model prob vs market price must differ by this much (6%)

  // Weekend / low-liquidity floor: BTC trades 24/7, but weekend volume is
  // real and realized vol readings can come in artificially low when few
  // market makers are active. Since the model's confidence scales with
  // 1/sigma, a falsely-low sigma makes it overconfident on noise right
  // when it should trust the signal LESS. This floor prevents that —
  // roughly ~11% annualized vol, well below BTC's typical range, so it
  // only kicks in during genuinely quiet stretches.
  MIN_SIGMA_PER_MINUTE: 0.00015,

  // Only attempt one entry per window, and only within this time-remaining
  // band (in seconds). Too early = thin/unstable market. Too late = no room
  // for the edge to play out and slippage eats it.
  // Rescaled proportionally for a 300s (5-min) window — the old 300-720s
  // band was sized for a 900s (15-min) window and wouldn't fit inside this
  // one at all (window length itself is 300s, so a 300s minimum would
  // basically never trigger).
  ENTRY_WINDOW_SECONDS_MIN: 100, // don't enter with less than ~1:40 left
  ENTRY_WINDOW_SECONDS_MAX: 240, // don't enter with more than 4:00 left

  // ---- Sizing ----
  KELLY_FRACTION: 0.25, // use 25% of full Kelly — full Kelly is too aggressive
  MAX_POSITION_PCT_OF_BANKROLL: 0.05, // hard cap: never risk more than 5% on one trade
  MIN_STAKE_DOLLARS: 5, // don't bother with dust-sized trades

  // ---- Fees (mirrors your other bots' 0.07 taker assumption) ----
  TAKER_FEE_RATE: 0.0, // demo mode: set to 0 for now so you see pure model edge.
  // Flip to 0.07 once you want to see fee-adjusted demo P&L.

  // ---- Resolution ----
  // Polymarket's own token price converges toward $1 for the winning side
  // and $0 for the losing side as a window resolves. We confirm outcomes
  // this way instead of guessing from an external price feed.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Loop timing ----
  POLL_INTERVAL_SECONDS: 20, // how often the bot checks the market

  // ---- Files ----
  STATE_FILE: './state.json',
};
