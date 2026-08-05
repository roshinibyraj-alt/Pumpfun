// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v6 — retest-confirmed maker base leg): ladder + counter-bet
// lock. No BTC price, no fair-value model, no directional prediction at
// all anymore. Pure Polymarket order-book mechanics:
//   1. At window start, watch six price rungs each on BOTH sides.
//      Polymarket has no conditional/stop order type, so a rung is
//      NOT a resting order — it's a trigger we detect by polling.
//   2. Once price moves BASE_ORDER_SLIPPAGE_CAP past a rung (confirms
//      a real breakout, not noise), rest a passive LIMIT order back
//      at the original rung price. Since price is already above that
//      level, the order isn't marketable when placed — it's a genuine
//      MAKER order ($0 fee) that fills only if price retests/pulls
//      back down to the rung. If it never does, that rung just never
//      fills — no cost, a real tradeoff of fill-rate for a fee-free,
//      price-certain entry. Once filled, place a counter order on the
//      OPPOSITE side, priced to lock a guaranteed profit once both legs
//      fill — regardless of which side the window actually resolves to.
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
  // opposite side is implied at $0.40 -> counter order at $0.35.
  //
  // NARROWED back from $0.10 to $0.05 (2026-08-05): the wider spread
  // required a much bigger pullback for the counter to fill than for the
  // base to fill (base only needs a retest of the rung; counter needs
  // price to travel all the way down to 1-P-spread) — within a 5-min
  // window, that mismatch meant many rungs never got hedged in time,
  // leaving naked directional exposure that lost far more than the
  // locked spread ever made (see 2026-08-05 log analysis: every balanced
  // UP=DOWN window was profitable, every imbalanced one lost money). A
  // tighter spread asks for a smaller pullback on the counter leg too,
  // raising the odds it fills before window close — trading a smaller
  // locked profit per hedge for a meaningfully lower naked-exposure rate.
  LOCK_SPREAD: 0.05,

  // ---- Fees & Rebates ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price), TAKERS ONLY.
  // Makers always pay $0 fee.
  //
  // Both legs are genuine MAKER fills (base: retest-confirmed passive
  // limit at the rung; counter: passive limit at the hedge price) — $0
  // fee on both, per v6.
  //
  // MAKER REBATE (estimate, not exact): Polymarket's Maker Rebates
  // Program pays out from a pool proportional to your share of total
  // maker volume in that market — we have no visibility into that share,
  // so an exact number isn't obtainable from this bot. As a standard
  // expected-value proxy, we estimate rebate = MAKER_REBATE_PCT × the
  // taker fee the counterparty would have paid on that same fill
  // (fee = shares × BASE_TAKER_FEE_RATE × p × (1-p)). This is an
  // approximation of expected rebate income, not a guaranteed payout —
  // real daily rebates depend on aggregate market activity you can't see
  // in advance.
  BASE_TAKER_FEE_RATE: 0.07, // Crypto category taker fee rate, used only to estimate counterparty fee for rebate calc
  MAKER_REBATE_PCT: 0.20,    // Crypto category maker rebate share, per Polymarket docs
  BASE_ORDER_SLIPPAGE_CAP: 0.02, // required confirmation buffer past the rung before resting the base order

  // ---- Time filters ----
  // No NEW base entries in the first minute of a window — price hasn't
  // had time to establish a real move yet, so early crosses are more
  // likely noise than a genuine breakout.
  ENTRY_BLACKOUT_START_SECONDS: 60,
  // No NEW base entries in the last minute either, and any base order
  // still resting unfilled at that point gets cancelled outright — a
  // fill with under a minute left has essentially no chance of getting
  // hedged before the window closes, so it would just become naked risk
  // with zero time to react. This is also when the fallback hedge below
  // kicks in for positions that are ALREADY filled.
  ENTRY_BLACKOUT_END_SECONDS: 60,

  // ---- Fallback hedge ----
  // If a base rung has already filled and the IDEAL counter price
  // (1-P-LOCK_SPREAD) hasn't been reached yet, and we're inside the
  // final ENTRY_BLACKOUT_END_SECONDS of the window, accept a worse but
  // still real hedge once the opposite side falls to this price instead
  // of holding out for the ideal one. This trades locked profit for a
  // bounded, known loss instead of riding a naked position with no time
  // left to react — e.g. base @ $0.70 + fallback @ $0.45 = $1.15 cost,
  // a guaranteed $0.15/share loss, instead of risking the full $0.70 if
  // the naked leg resolves to zero. Only ever used as a last resort —
  // the ideal counter price is always tried first, for as long as there's
  // time left to wait for it.
  FALLBACK_HEDGE_PRICE: 0.45,

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
