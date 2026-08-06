// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v11 — candle-pattern side selection + timed forced entry,
// $-notional sizing, no hedge):
//   1. Whenever a new Polymarket UP/DOWN window is detected, fetch the
//      last CANDLE_LOOKBACK CLOSED real BTC/ETH candles (Binance,
//      CANDLE_INTERVAL) and run them through strategy.detectPattern()
//      exactly as before to pick a side: MOMENTUM_UP/DOWN,
//      REVERSAL_UP/DOWN, or CHOP/NONE (no trade).
//   2. If CHOP/NONE, the window is SKIPPED — no order at all.
//   3. If a side is picked, entry timing/price now works like this:
//        - From window start (0s) to ENTRY_WAIT_SECONDS: watch the
//          signaled side's live price every tick. The INSTANT it drops
//          to <= EARLY_ENTRY_TRIGGER_PRICE, fire an immediate buy
//          (this is a genuine TAKER order — it executes right away at
//          whatever the price is at that moment, it does NOT rest and
//          wait for a retest like the old dip-buy did).
//        - If ENTRY_WAIT_SECONDS elapses with no trigger, fire an
//          immediate buy anyway, at whatever the current price is —
//          no price condition at that point. Also a genuine TAKER
//          order.
//      Net effect: EVERY window that gets a directional signal WILL
//      get a trade — either an early cheap fill, or a forced fill at
//      whatever price is showing once the minute is up.
//   4. Every entry is sized in DOLLARS, not shares:
//      shares = ORDER_NOTIONAL_USD / fillPrice (fractional shares
//      allowed). This means the entry price directly determines how
//      many shares you end up holding — a cheaper fill buys more
//      shares for the same $ risk.
//   5. NO take-profit exit anymore (v12): every filled position rides
//      naked all the way to real resolution. A window resolves the
//      instant either side's price is observed at/above
//      RESOLUTION_WIN_THRESHOLD in the LAST tick sampled before the
//      window closes — that side is declared the winner immediately,
//      no waiting on the official market to fully settle. If neither
//      side had cleared the threshold by that last tick, resolution
//      falls back to polling the real market price until it converges.
//   6. Sizing is FIXED: every trade uses ORDER_NOTIONAL_USD, no
//      martingale, no doubling, no loss-streak tracking of any kind.
//      Wins and losses have no effect on the size of the next trade.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Bankroll ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix AND maps to a Binance symbol (BTCUSDT/ETHUSDT) in binance.js
  WINDOW_MINUTES: 5,

  // ---- Candle pattern source (unchanged from v10) ----
  // Real exchange candles for the underlying asset from Binance's
  // public REST API — NOT the Polymarket UP/DOWN token price.
  CANDLE_INTERVAL: '5m',
  CANDLE_LOOKBACK: 4,

  // ---- Entry timing/price ----
  // Wait this long after window start before forcing an entry.
  ENTRY_WAIT_SECONDS: 60,
  // During the wait window, fire the instant the signaled side's
  // price drops to or below this level. This is checked every tick
  // from window start; if it never happens, ENTRY_WAIT_SECONDS forces
  // the entry anyway at whatever price is showing then.
  EARLY_ENTRY_TRIGGER_PRICE: 0.33,

  // ---- Position sizing ----
  // Fixed dollar notional for EVERY trade, no exceptions. shares =
  // ORDER_NOTIONAL_USD / fillPrice, computed at fill time — not a
  // fixed share count. No martingale, no doubling, no dependence on
  // past wins/losses.
  ORDER_NOTIONAL_USD: 50,

  // ---- Fees ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price), TAKERS ONLY.
  // The ENTRY is a genuine taker fill (pays this fee) since it
  // executes immediately rather than resting. There is no maker leg
  // anymore (v12 removed the resting TP sell), so no rebate ever
  // applies.
  BASE_TAKER_FEE_RATE: 0.07, // Crypto category taker fee rate

  // ---- Resolution ----
  // A position rides naked to real resolution — no take-profit exit.
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
  // two tokens checked per tick. The Binance klines call only happens
  // once per NEW window (not every tick), so it stays well within
  // Binance's public rate limits too.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
