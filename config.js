// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v17 — time-scheduled cheap/expensive buys, 5-minute
// window, fixed share sizes per side):
//   1. Every 5-minute Polymarket UP/DOWN window is traded.
//   2. CHEAP side (the side with the LOWER midpoint) is bought
//      once at each of these seconds after window start:
//        t = 30s    -> buy CHEAP, 50 shares
//        t = 60s    -> buy CHEAP, 50 shares
//        t = 90s    -> buy CHEAP, 50 shares
//   3. EXPENSIVE side (the side with the HIGHER midpoint) is
//      bought once at each of:
//        t = 210s   -> buy EXPENSIVE, 100 shares
//        t = 240s   -> buy EXPENSIVE, 100 shares
//        t = 270s   -> buy EXPENSIVE, 100 shares
//   4. Cheap/expensive is re-evaluated FRESH at each scheduled
//      tick from the live midpoints — the sides may flip mid-
//      window and each order simply follows whichever side is
//      cheap/expensive right then.
//   5. Every cheap buy is exactly CHEAP_ORDER_SHARES (50) shares and
//      every expensive buy is exactly EXPENSIVE_ORDER_SHARES (100)
//      shares, regardless of cost. No ladder, no pattern, no hedge.
//   6. Fees/rebates (per docs.polymarket.com/trading/fees and
//      docs.polymarket.com/programs/maker-rebates):
//        - Crypto category: taker fee rate = 0.07
//        - Makers are never charged fees; taker fee formula is
//          fee = shares x feeRate x price x (1 - price)
//        - Crypto maker rebate = 20% of the fee-equivalent,
//          paid to resting (maker) fills only
//        - ENTRY_IS_MAKER=false (default) models our entries as
//          taker fills at the current mid: fee applies, rebate 0.
//          Flip it to true to model resting maker fills instead:
//          no fee, 20% rebate credited.
//   7. Filled entries ride naked to real resolution — no take-
//      profit exit. Resolution: whichever side is at/above the win
//      threshold in the last tick before close is declared the
//      winner immediately; otherwise fall back to polling the real
//      market price until it converges.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Bankroll ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix
  WINDOW_MINUTES: 5, // always 5-minute windows

  // ---- Order size ----
  // Every scheduled buy is exactly this many shares, regardless of
  // what the price/cost is. No scaling, no ladder.
  // CHEAP side: 50 shares per buy. EXPENSIVE side: 100 shares per buy.
  CHEAP_ORDER_SHARES: 50,
  EXPENSIVE_ORDER_SHARES: 100,

  // ---- Cheap-side schedule ----
  // One 50-share buy on the cheaper side at each of these seconds
  // after window start (NOT at t=0 — first buy is at the 30th sec).
  CHEAP_BUY_AT_SECS: [30, 60, 90],

  // ---- Expensive-side schedule (late window) ----
  // One 100-share buy on the expensive side at each of these seconds.
  EXPENSIVE_BUY_AT_SECS: [210, 240, 270],

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
  // Positions ride naked to real resolution — no take-profit exit.
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
  // two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
