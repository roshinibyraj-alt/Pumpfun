// ============================================================
// CONFIG — every knob you'd want to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v9 — dip-buy + take-profit, no hedge):
//   1. At window start, wait until minute ENTRY_CHECK_MINUTE of the
//      window. From that point on, check every tick: if the UP token's
//      price is between ENTRY_PRICE_MIN and ENTRY_PRICE_MAX (DOWN is
//      the complement, so checking UP alone covers both sides), place
//      TWO resting limit BUY orders — one UP, one DOWN — both at
//      LIMIT_BUY_PRICE, for CURRENT_SHARES_PER_SIDE shares each. Both
//      orders sit below current market price, so they're genuine MAKER
//      orders ($0 fee) that only fill if that side's price falls all
//      the way down to LIMIT_BUY_PRICE. This only happens ONCE per
//      window — first tick the condition is true.
//   2. Once a leg fills, rest a take-profit SELL limit order at
//      TAKE_PROFIT_PRICE for that same leg. This is also a genuine
//      resting MAKER order (priced above current market at the time
//      it's placed) — it fills only if that side's price rallies all
//      the way back up to TAKE_PROFIT_PRICE before the window closes.
//   3. There is NO hedge, NO counter-bet, and NO cross-side logic of
//      any kind. Each leg is fully independent: it either (a) never
//      fills (order expires worthless, no cost), (b) fills and hits
//      TP (locks in TAKE_PROFIT_PRICE - LIMIT_BUY_PRICE profit/share),
//      or (c) fills and does NOT hit TP before the window closes, in
//      which case it rides naked to the real window outcome — full
//      win ($1/share) or full loss ($0/share).
//   4. Martingale sizing: the bot tracks CONSECUTIVE losing windows
//      (a window counts as a loss if its net pnl < $0). Every time the
//      consecutive-loss streak hits a fresh multiple of
//      CONSECUTIVE_LOSS_DOUBLE_THRESHOLD (default 8), the share size
//      used for the NEXT window's entry doubles. A win resets the
//      streak to 0 (but does NOT reset share size back down — that's
//      a separate, deliberate choice; see bot.js if you want it to
//      reset on a win instead).
//
// IMPORTANT TIMING NOTE: with a 5-minute window and
// ENTRY_CHECK_MINUTE=4, the entry check only starts with ~1 minute
// left in the window. That's very little time for price to (a) dip to
// LIMIT_BUY_PRICE to fill the base order AND (b) rally back up to
// TAKE_PROFIT_PRICE to fill the TP — most filled legs will likely
// ride unresolved-TP to the window's real outcome instead. This is
// exactly what was requested; flagging it here so it's not a surprise
// when TP fill rates look low.
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

  // ---- Entry timing ----
  // No entry check at all before this many minutes have elapsed in the
  // window. From this point onward, every tick checks the price-range
  // condition below until it fires (once) or the window ends.
  ENTRY_CHECK_MINUTE: 4,

  // Entry only fires if the UP token's price is within this range when
  // checked (DOWN is the complement of UP, so this single check covers
  // both sides — if UP is in [0.30, 0.70], DOWN necessarily is too).
  ENTRY_PRICE_MIN: 0.30,
  ENTRY_PRICE_MAX: 0.70,

  // ---- Orders ----
  // Both legs (UP and DOWN) are bought via a resting limit order at
  // this price the moment entry fires. No hedge, no counter-leg.
  LIMIT_BUY_PRICE: 0.10,
  // Take-profit: a resting limit SELL at this price for any leg that
  // fills. Locks in (TAKE_PROFIT_PRICE - LIMIT_BUY_PRICE) per share if
  // it fills before the window closes.
  TAKE_PROFIT_PRICE: 0.90,

  // ---- Position sizing / martingale ----
  // Shares per side for the very first window. The bot persists the
  // CURRENT working share size in state (state.currentShareSize) and
  // doubles it every time the consecutive-loss streak hits a fresh
  // multiple of CONSECUTIVE_LOSS_DOUBLE_THRESHOLD below.
  BASE_SHARES_PER_SIDE: 10,
  // After this many CONSECUTIVE losing windows (net pnl < 0), double
  // the share size used going forward. Keeps doubling again every
  // additional CONSECUTIVE_LOSS_DOUBLE_THRESHOLD losses on top of that
  // (e.g. doubles again at 16 consecutive losses, and so on) until a
  // winning window resets the loss streak.
  CONSECUTIVE_LOSS_DOUBLE_THRESHOLD: 8,

  // ---- Fees & Rebates ----
  // Confirmed against Polymarket's official docs (docs.polymarket.com/trading/fees):
  //   fee = shares × feeRate × price × (1 - price), TAKERS ONLY.
  // Makers always pay $0 fee. Every order this bot places (entry buy,
  // TP sell) is a genuine resting maker order, so fees are always $0 —
  // BASE_TAKER_FEE_RATE is only used to estimate the maker rebate.
  BASE_TAKER_FEE_RATE: 0.07, // Crypto category taker fee rate, used only to estimate counterparty fee for rebate calc
  MAKER_REBATE_PCT: 0.20,    // Crypto category maker rebate share, per Polymarket docs

  // ---- Resolution (for any leg left unhedged/no-TP at window close) ----
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
