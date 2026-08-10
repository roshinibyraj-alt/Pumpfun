// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v21 — two different engines):
//
//   5m engine  — DIP_RECOVERY (unchanged from v20):
//     1. MONITOR first 120s, record the last moment each side is
//        below DIP_LEVEL (0.50).
//     2. TARGET = the side whose most recent sub-0.50 dip was latest.
//        No dip at all -> no trade.
//     3. After 120s, once the target returns to RETURN_LEVEL (0.50),
//        buy BUY_AMOUNT ($100) worth: shares = floor($100 / price).
//     4. STOP LOSS 0.20; otherwise ride to resolution.
//
//   15m engine — EXPENSIVE_RECOVERY:
//     1. At/after ENTRY_AFTER_SECS (420s / 7 min), buy ENTRY_SHARES
//        (300) on the EXPENSIVE side at ANY price.
//     2. STOP LOSS 0.40. Right after entry the bot computes the loss
//        that an SL hit would realize:
//          L = (fill - 0.40) x 300 + fee
//     3. If a carry is still owed at the 420s signal, ALSO place a
//        CARRY-RECOVERY bet on the SIGNAL side (the expensive side)
//        sized to recover the carry; the signal logic runs as normal.
//     4. When SL hits (and no carry-recovery is riding this window),
//        immediately place a RECOVERY bet on the OPPOSITE side, sized
//        so a win recovers L plus any carried amount from previous
//        windows:
//          shares = ceil((carry + L) / ((1 - p) x (1 - 0.07p)))
//     5. EVERY bet (main, in-window recovery, carry-recovery) carries
//        STOP LOSS 0.40. A stopped-out recovery realizes its loss
//        immediately and the full loss rolls into the carry.
//     6. Recovery wins  -> carry cleared. Recovery loses or is stopped
//        out -> carry = pre-carry + all losses this window, and the
//        next 420s signal places a carry-recovery for it. A main-bet
//        win leaves the carry untouched — only a recovery win clears it.
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
      MONITOR_SECS: 120, // first 2 minutes
      // A side "dipped" while its price is below this level.
      DIP_LEVEL: 0.50,
      // Buy trigger: target side's price comes back to this level
      // any time after the monitor phase.
      RETURN_LEVEL: 0.50,
      // Notional size of the single buy: $100 worth of shares.
      BUY_AMOUNT: 100,
      // Stop loss: if the bought side's price hits this level, exit
      // at this price and realize the loss.
      STOP_LOSS_LEVEL: 0.20,
    },
    '15m': {
      label: '15m',
      STRATEGY: 'EXPENSIVE_RECOVERY',
      WINDOW_MINUTES: 15,
      CAPITAL: 1000,
      // Entry: at/after this many seconds, buy the expensive side at
      // any price.
      ENTRY_AFTER_SECS: 420, // 7 minutes
      // Fixed share size for the main entry.
      ENTRY_SHARES: 300,
      // Stop loss for the main entry.
      STOP_LOSS_LEVEL: 0.40,
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
