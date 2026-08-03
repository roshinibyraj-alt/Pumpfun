// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders

  // Re-enabled per explicit request — staying live in demo mode while
  // testing the new price-level entry filter below (PRICE_ENTRY_LEVEL).
  TRADING_ENABLED: true,

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

  // Only attempt one entry per window. Previously restricted to a narrow
  // time band; now opened to the full window (5s-295s remaining, i.e.
  // almost the entire 300s window) since entry is now additionally gated
  // by PRICE_ENTRY_LEVEL below — it can fire whenever that price
  // condition is met, not just in a fixed time slice.
  ENTRY_WINDOW_SECONDS_MIN: 5, // don't enter with less than 5s left (model math degenerates near zero time)
  ENTRY_WINDOW_SECONDS_MAX: 295, // don't enter in literally the first instant of the window

  // Only enter once the edge-side token has actually dropped to this
  // price or below — buying the edge side cheap rather than at whatever
  // price it happens to be when the edge threshold first clears. Still
  // requires MIN_EDGE_TO_TRADE to be met too; this is an additional
  // filter, not a replacement.
  PRICE_ENTRY_LEVEL: 0.33,

  // Only enter when the model itself is near-neutral (no strong directional
  // view) but the market is pricing one side as a clear underdog anyway —
  // i.e. trade the market's conviction against the model's lack of one,
  // rather than trading on the model's own conviction. Note: earlier data
  // mining on 206 real trades showed the OPPOSITE pattern performed better
  // (58% win rate when the model was highly confident vs 38.5% when near
  // 50%) — this filter deliberately narrows toward the historically worse
  // segment. Implemented as requested; worth watching shadow stats closely.
  MODEL_NEUTRAL_BAND_PP: 5, // model probability must be within this many pp of 50%

  // ---- Sizing ----
  STAKE_MODE: 'fixed', // 'fixed' or 'kelly'
  FIXED_STAKE_AMOUNT: 50, // used when STAKE_MODE === 'fixed' — flat $ per trade, no compounding
  KELLY_FRACTION: 0.25, // used only when STAKE_MODE === 'kelly' — 25% of full Kelly
  MAX_POSITION_PCT_OF_BANKROLL: 0.05, // used only when STAKE_MODE === 'kelly'
  MIN_STAKE_DOLLARS: 5, // don't bother with dust-sized trades

  // ---- Fees ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  // crypto-category markets charge a 7% taker fee (makers pay 0). The real
  // formula is fee = shares × rate × price × (1-price); for a fixed dollar
  // stake that simplifies to fee = stake × rate × (1 - price) — so cheap/
  // longshot entries cost proportionally MORE in fees, not less. bot.js
  // applies this formula directly rather than a flat percentage.
  TAKER_FEE_RATE: 0.07,

  // ---- Resolution ----
  // Polymarket's own token price converges toward $1 for the winning side
  // and $0 for the losing side as a window resolves. We confirm outcomes
  // this way instead of guessing from an external price feed.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s (150/s) per
  // IP — very generous, so we poll every 2s instead of 20s for genuinely
  // live CLOB prices. To avoid wasting that on redundant work, bot.js
  // caches the per-window market lookup + strike (only refetched when the
  // window rolls over) and recomputes volatility on its own slower cadence
  // below, rather than on every single 2s tick.
  POLL_INTERVAL_SECONDS: 2,
  VOL_RECOMPUTE_INTERVAL_SECONDS: 30,

  // ---- Files ----
  STATE_FILE: './state.json',
};
