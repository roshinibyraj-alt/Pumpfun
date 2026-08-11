// ============================================================
// CONFIG — every knob you'd like to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v24 — dip signal + bucket filter, no stop loss):
//
//   BOTH engines (5m and 15m) run the SAME DIP_RECOVERY logic,
//   the 15m being a proportional mirror of the 5m:
//     1. MONITOR the first MONITOR_SECS (5m: 90s, 15m: 270s), record
//        the last moment each side is below DIP_LEVEL (0.50).
//     2. TARGET = the side whose most recent sub-0.50 dip was latest.
//        No dip at all -> no trade.
//     3. After the monitor phase, once the target returns to
//        RETURN_LEVEL (0.50), buy BUY_AMOUNT worth PLUS the mini
//        bucket installment:
//          shares = floor(BUY_AMOUNT / px) + floor(miniBucket / px)
//     4. NO STOP LOSS — every position rides to resolution.
//
//   BUCKET FILTER (main + mini):
//     - Every loss adds its FULL dollar loss to that engine's MAIN
//       bucket, then re-splits: miniBucket = bucket / BUCKET_DIVISOR.
//     - The next window bets base + miniBucket.
//     - ONE win of a mini-bucket bet clears the WHOLE bucket (main and
//       mini go to 0). A loss adds its full loss to main and re-splits
//       by BUCKET_DIVISOR again.
//     - The 5m and 15m engines each have their OWN independent
//       main/mini buckets and their own capital.
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

  // ---- Bucket filter ----
  // After a loss, the full lost amount goes into the per-engine MAIN
  // bucket and is re-split into a mini installment:
  //   miniBucket = bucket / BUCKET_DIVISOR
  // The next window bets base + miniBucket. ONE win clears the whole
  // bucket; a loss adds its full loss to main and re-splits again.
  // Both engines use the same divisor.
  BUCKET_DIVISOR: 2,

  // ---- Engines ----
  // Each engine runs on its own window length with its OWN bankroll,
  // current window, and history. Keys ('5m' / '15m') are used
  // everywhere in state and the dashboard.
  ENGINES: {
    '5m': {
      label: '5m',
      STRATEGY: 'DIP_RECOVERY',
      WINDOW_MINUTES: 5,
      CAPITAL: 1000, // this engine's starting bankroll (independent)
      // Monitor phase length: watch both sides this long for a dip.
      MONITOR_SECS: 90, // first 1.5 minutes
      // A side "dipped" while its price is below this level.
      DIP_LEVEL: 0.50,
      // Buy trigger: target side's price comes back to this level
      // any time after the monitor phase.
      RETURN_LEVEL: 0.50,
      // Notional size of the base buy: $100 worth of shares (the
      // mini bucket installment is added on top).
      BUY_AMOUNT: 100,
    },
    '15m': {
      label: '15m',
      STRATEGY: 'DIP_RECOVERY',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
      // Proportional mirror of the 5m engine (3x the time -> 3x the
      // monitor length and 3x the base buy size).
      MONITOR_SECS: 270, // 3 x 90s (first 4.5 minutes of a 15m window)
      // A side "dipped" while its price is below this level.
      DIP_LEVEL: 0.50,
      RETURN_LEVEL: 0.50,
      BUY_AMOUNT: 300, // 3 x $100 base notional (mini added on top)
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
