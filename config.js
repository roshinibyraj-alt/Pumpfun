// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v4 — market-order base leg): ladder + counter-bet lock.
// No BTC price, no fair-value model, no directional prediction at
// all anymore. Pure Polymarket order-book mechanics:
//   1. At window start, watch six price rungs each on BOTH sides.
//      Polymarket has no conditional/stop order type, so a rung is
//      NOT a resting order — it's a trigger we detect by polling.
//   2. When price crosses a rung, immediately fire a TAKER market
//      order (FOK/FAK) for that side — this pays the real Crypto
//      category taker fee, and may fill at a worse price than the
//      nominal rung price under slippage (not yet modeled; see
//      BASE_TAKER_FEE_RATE below). Once filled, place a counter
//      order on the OPPOSITE side, priced to lock a guaranteed
//      profit once both legs fill — regardless of which side the
//      window actually resolves to.
//   3. The counter order is a genuine resting GTC/GTD limit order
//      (maker, $0 fee) — this one really can sit and wait.
//   4. If a rung's base fills but its counter never does before
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
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price)
  // Only TAKERS pay this fee; makers always pay $0.
  //
  // Base leg is now a TAKER order (market order, FOK/FAK) — per the design
  // decision that a resting limit order above current price for a breakout
  // entry would just fill immediately as a taker anyway, so we chase the
  // move deliberately with a market order instead of pretending it's a
  // passive maker fill. BTC/ETH up-down markets fall under Polymarket's
  // "Crypto" category, feeRate = 0.07 (peaks at $1.75 per 100 shares @ 50c).
  BASE_TAKER_FEE_RATE: 0.07,

  // Counter leg is still a genuine resting GTC/GTD limit order placed
  // below market after the base fills — a real maker fill, $0 fee. We do
  // NOT add a maker rebate on top: the actual rebate payout depends on
  // your share of total maker volume in that market, which we have no
  // way to see or simulate honestly, so modeling it would be fabricated.
  COUNTER_MAKER_FEE_RATE: 0,

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
