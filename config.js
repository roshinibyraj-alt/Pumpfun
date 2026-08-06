// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v10 — candle-pattern directional entry, no hedge, no
// dual-side dip-buy):
//   1. Whenever a new Polymarket UP/DOWN window is detected, fetch the
//      last CANDLE_LOOKBACK CLOSED candles for the underlying asset
//      (real BTC/ETH price candles from Binance, NOT the Polymarket
//      token price) at CANDLE_INTERVAL granularity.
//   2. Classify each candle Green (close > open) or Red (close < open)
//      and match the sequence against a fixed pattern table:
//        GGG / RRR        -> momentum continuation  -> trade WITH it
//        GG  / RR         -> momentum continuation  -> trade WITH it
//        GR                -> reversal (buyer exhaustion) -> trade DOWN
//        RG                -> reversal (seller exhaustion) -> trade UP
//        GRG / RGR / GRGR  -> chop / whipsaw          -> NO TRADE
//        anything else (not enough clean candles yet) -> NO TRADE
//      Longer/more specific patterns are checked first (e.g. GRGR/GRG
//      chop overrides what the last two candles alone would suggest).
//   3. If the pattern gives a directional signal, place ONE resting
//      limit BUY order on the signaled side only (no order on the
//      other side at all) at LIMIT_BUY_PRICE, sized at the current
//      martingale share size — but only if that side's live Polymarket
//      price is still within [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX] (a
//      sanity check so we don't rest a $0.10 buy on a market that's
//      already basically decided).
//   4. Once filled, a take-profit SELL rests at TAKE_PROFIT_PRICE.
//   5. If the pattern is chop / inconclusive, or the sanity price
//      check fails, the window is SKIPPED entirely — no order on
//      either side. Skipped windows do not affect the loss streak or
//      share size (see below) since no trade was actually made.
//   6. Martingale sizing unchanged in spirit: state.consecutiveLosses
//      counts consecutive LOSING TRADED windows (skips don't count).
//      Every fresh multiple of CONSECUTIVE_LOSS_DOUBLE_THRESHOLD
//      doubles state.currentShareSize for the next traded window. A
//      winning traded window resets the streak to 0 (share size is
//      NOT auto-reset on a win).
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Bankroll ----
  STARTING_BANKROLL: 1000, // virtual dollars to start with

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix AND maps to a Binance symbol (BTCUSDT/ETHUSDT) in candles.js
  WINDOW_MINUTES: 5,

  // ---- Candle pattern source ----
  // Real exchange candles for the underlying asset, fetched from
  // Binance's public REST API (no key required). NOT the Polymarket
  // UP/DOWN token price — that's a separate, derived market.
  // Interval string must be a valid Binance kline interval, e.g.
  // '1m', '3m', '5m', '15m'. Default 5m so GGG/RRR = the "classic
  // 15-minute momentum streak" (3 x 5m).
  CANDLE_INTERVAL: '5m',
  // How many of the most recent CLOSED candles to fetch/consider.
  // Needs to be >= 4 to detect the GRGR chop pattern.
  CANDLE_LOOKBACK: 4,

  // ---- Entry sanity filter ----
  // Even with a directional signal, skip the trade if the signaled
  // side's live Polymarket price is already outside this range (i.e.
  // the market's basically already decided one way or the other, so a
  // resting $0.10 buy is pointless or the price won't behave like an
  // early-window dip anymore).
  ENTRY_PRICE_MIN: 0.30,
  ENTRY_PRICE_MAX: 0.70,

  // ---- Orders ----
  // The single signaled leg is bought via a resting limit order at
  // this price. No hedge, no counter-leg, no other side touched.
  LIMIT_BUY_PRICE: 0.10,
  // Take-profit: a resting limit SELL at this price once filled.
  TAKE_PROFIT_PRICE: 0.90,

  // ---- Position sizing / martingale ----
  // Shares for the very first traded window. Persisted + updated in
  // state.currentShareSize.
  BASE_SHARES: 10,
  // After this many CONSECUTIVE losing TRADED windows (net pnl < 0;
  // skipped/no-trade windows don't count either way), double the share
  // size used going forward. Keeps doubling again every additional
  // CONSECUTIVE_LOSS_DOUBLE_THRESHOLD losses until a winning traded
  // window resets the streak.
  CONSECUTIVE_LOSS_DOUBLE_THRESHOLD: 8,

  // ---- Fees & Rebates ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price), TAKERS ONLY.
  // Makers always pay $0 fee. Both the entry buy and the TP sell are
  // genuine resting maker orders, so fees are always $0 —
  // BASE_TAKER_FEE_RATE is only used to estimate the maker rebate.
  BASE_TAKER_FEE_RATE: 0.07, // Crypto category taker fee rate, used only to estimate counterparty fee for rebate calc
  MAKER_REBATE_PCT: 0.20,    // Crypto category maker rebate share, per Polymarket docs

  // ---- Resolution (for a filled leg left naked / no TP at window close) ----
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
