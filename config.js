// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v19 — dual engines: 5m + 15m, independent capital):
//   1. The bot runs TWO independent engines at the same time:
//        - 5m  engine: every 5-minute  UP/DOWN window, own bankroll
//        - 15m engine: every 15-minute UP/DOWN window, own bankroll
//      Each engine has its own schedule, bankroll, history, and
//      pending resolutions — one never touches the other's money.
//   2. CHEAP side (the side with the LOWER midpoint) is bought
//      once per scheduled second (5m: 30/60/90s, 15m: 90/180/270s)
//      at CHEAP_ORDER_SHARES per buy.
//   3. EXPENSIVE side (the side with the HIGHER midpoint) is bought
//      once per scheduled second:
//        - 5m:  150s / 180s / 210s
//        - 15m: 570s / 660s / 750s
//      at EXPENSIVE_ORDER_SHARES per buy.
//   4. EXPENSIVE-side buys only fire while the expensive side's
//      midpoint is BELOW EXPENSIVE_BUY_MAX_PRICE (default 0.90).
//      If the price stays at/above 0.90 for the whole validity
//      window, that buy is skipped (never chased at a bad price).
//   5. Cheap/expensive is re-evaluated FRESH at each scheduled
//      tick from the live midpoints — the sides may flip mid-
//      window and each order simply follows whichever side is
//      cheap/expensive right then.
//   6. Every cheap buy is exactly CHEAP_ORDER_SHARES and every
//      expensive buy is exactly EXPENSIVE_ORDER_SHARES shares,
//      regardless of cost. No ladder, no pattern, no hedge.
//   7. Fees/rebates (per docs.polymarket.com/trading/fees and
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
//   8. Filled entries ride naked to real resolution — no take-
//      profit exit. Resolution: whichever side is at/above the win
//      threshold in the last tick before close is declared the
//      winner immediately; otherwise fall back to polling the real
//      market price until it converges.
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
  // schedule, history, and pending resolutions. Keys are the engine
  // ids ('5m' / '15m') used everywhere in state and the dashboard.
  ENGINES: {
    '5m': {
      label: '5m',
      WINDOW_MINUTES: 5,
      CAPITAL: 1000, // this engine's starting bankroll (independent)
      CHEAP_ORDER_SHARES: 50,
      EXPENSIVE_ORDER_SHARES: 100,
      // CHEAP: one buy at each of these seconds after window open.
      CHEAP_BUY_AT_SECS: [30, 60, 90],
      // EXPENSIVE: one buy at each of these seconds after window open.
      EXPENSIVE_BUY_AT_SECS: [150, 180, 210],
      // Each scheduled buy may fire during this many seconds after
      // its scheduled second (so a mid-window restart doesn't dump
      // all missed buys at once).
      BUY_FIRE_VALIDITY_SECS: 30,
      // EXPENSIVE-side buys only fire while the expensive side's
      // midpoint is below this price. If it never drops below during
      // the validity window, that buy is skipped.
      EXPENSIVE_BUY_MAX_PRICE: 0.90,
    },
    '15m': {
      label: '15m',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
      CHEAP_ORDER_SHARES: 50,
      EXPENSIVE_ORDER_SHARES: 100,
      CHEAP_BUY_AT_SECS: [90, 180, 270],
      EXPENSIVE_BUY_AT_SECS: [570, 660, 750],
      BUY_FIRE_VALIDITY_SECS: 90,
      EXPENSIVE_BUY_MAX_PRICE: 0.90,
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
  // two engines x two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
