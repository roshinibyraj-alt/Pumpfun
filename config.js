// ============================================================
// CONFIG — every knob you'd like to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v22 — one unified engine shape, bucket filter):
//
//   BOTH engines (5m and 15m) run the SAME DIP_RECOVERY logic,
//   the 15m being a proportional mirror of the 5m:
//     1. MONITOR the first MONITOR_SECS (5m: 90s, 15m: 270s), record
//        the last moment each side is below DIP_LEVEL (0.50).
//     2. TARGET = the side whose most recent sub-0.50 dip was latest.
//        No dip at all -> no trade.
//     3. After the monitor phase, once the target returns to
//        RETURN_LEVEL (0.50), buy BUY_AMOUNT (5m: $100, 15m: $300)
//        worth PLUS the bucket third:
//          shares = floor(BUY_AMOUNT / px) + floor((bucket/3) / px)
//     4. STOP LOSS 0.20 on every position for both engines; otherwise
//        ride to resolution.
//
//   BUCKET FILTER (the main money filter):
//     - When a bet is stopped out or resolves as a loss, the FULL
//       dollar loss goes into that engine's bucket.
//     - The next window's bet is base + bucket ÷ BUCKET_DIVISOR (3).
//     - If that bet loses again, its full loss is added to the bucket
//       and the next bet is again base + bucket ÷ 3.
//     - If a bucket bet WINS, the bucket shrinks by the bucket third
//       that was wagered (the amount that bet recovered) — it does
//       NOT reset to zero; it shrinks until clear.
//     - The 5m and 15m engines each have their OWN independent
//       bucket and their own capital.
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
  // After a loss, the lost amount goes into a per-engine bucket. The
  // next window bets base + bucket / BUCKET_DIVISOR. Wins shrink the
  // bucket by the bucket third wagered; losses grow it by the full
  // loss. Both engines use the same divisor.
  BUCKET_DIVISOR: 3,

  // ---- Engines ----
  // Each engine runs on its own window length with its OWN bankroll,
  // own bucket, current window, and history. Keys ('5m' / '15m') are
  // used everywhere in state and the dashboard.
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
      // bucket third is added on top).
      BUY_AMOUNT: 100,
      // Stop loss: if the bought side's price hits this level, exit
      // at this price and realize the loss.
      STOP_LOSS_LEVEL: 0.20,
    },
    '15m': {
      label: '15m',
      STRATEGY: 'DIP_RECOVERY',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
      // Proportional mirror of the 5m engine (3x the time -> 3x the
      // monitor length and 3x the base buy size).
      MONITOR_SECS: 270, // 3 x 90s (first 4.5 minutes of a 15m window)
      DIP_LEVEL: 0.50,
      RETURN_LEVEL: 0.50,
      BUY_AMOUNT: 300, // 3 x $100 base notional
      STOP_LOSS_LEVEL: 0.20, // same stop loss as the 5m engine
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
