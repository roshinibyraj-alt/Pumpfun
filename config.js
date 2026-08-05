// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v2 — complete rewrite): ladder + counter-bet lock.
// No BTC price, no fair-value model, no directional prediction at
// all anymore. Pure Polymarket order-book mechanics:
//   1. At window start, rest limit orders on BOTH sides at six
//      price rungs each.
//   2. Whichever rungs get filled (market trades down through
//      that price), immediately place a counter order on the
//      OPPOSITE side, priced to lock a guaranteed profit once
//      both legs fill — regardless of which side the window
//      actually resolves to.
//   3. If a rung's base fills but its counter never does before
//      the window closes, that leftover position rides to real
//      resolution like a normal directional bet.
// Every rung is independent — filling one never cancels or
// affects any other rung.
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

  // ---- Ladder ----
  // v3-reversed (breakout entry): base leg fires when price rises TO OR
  // ABOVE a rung. These levels sit ABOVE the typical ~0.50 starting price
  // (mirrored from the old dip-buy levels 0.40..0.15) so a rung only
  // fires on a genuine upward move through that level — NOT trivially at
  // window open. Do not set these below ~0.50 with the reversed trigger,
  // or every rung fires at once regardless of price action.
  RUNG_PRICES: [0.60, 0.65, 0.70, 0.75, 0.80, 0.85], // applied to BOTH sides independently
  SHARES_PER_RUNG: 20, // fixed share count per rung, both the base leg and its counter leg

  // Once a base rung fills at price P, the counter order on the opposite
  // side is placed at (1 - P - LOCK_SPREAD). E.g. base fills at $0.60 ->
  // opposite side is implied at $0.40 -> counter order at $0.35. If both
  // fill, cost = P + (1-P-spread) = 1-spread per share pair, but exactly
  // one side always pays $1/share at resolution — so profit is locked at
  // LOCK_SPREAD per share, guaranteed, the moment the counter fills.
  LOCK_SPREAD: 0.05,

  // ---- Fees ----
  // Both the base and counter legs are RESTING limit orders (we're the
  // maker, someone else's market order fills against us) — confirmed
  // against Polymarket's official docs that makers pay $0 fees. There's
  // also a maker rebate program, but the actual payout depends on your
  // share of total maker volume in that market at that moment, which we
  // have no way to see or simulate honestly — so we model $0 fees (real,
  // verifiable) and do NOT fabricate a rebate number on top of it.
  TAKER_FEE_RATE: 0,

  // ---- Resolution (for any base leg left unhedged at window close) ----
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s (150/s)
  // per IP. Polling every 500ms uses a small fraction of that even with
  // two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
