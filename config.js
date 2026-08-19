// ============================================================
// CONFIG — every knob you'd like to tune lives here.
// Change numbers, restart the bot (Railway redeploys automatically
// when you push to GitHub), no need to touch other files.
//
// STRATEGY (v32 — LEADER, single 15m engine, TAKER execution):
//
//   The ONLY live strategy is LEADER: when one side's price DIPS to
//   a trigger level, the bot buys the OPPOSITE (leader) side — the
//   side that did NOT dip — instead of buying the dip.
//
//   1. One 5-minute window engine only. Separate demo
//      capital, equity curve, drawdown, and streak per engine.
//   2. Trigger levels at LADDER_RUNGS (0.40 down to 0.10): the first
//      time a side's mid is observed AT OR BELOW a level in a window,
//      the bot fires a TAKER market buy on the opposite side — the
//      leader side that did NOT dip. 50 fixed shares per trigger,
//      filled immediately at the current leader mid ± realistic
//      slippage (TAKER_SLIPPAGE_MIN/MAX). Each side+level can trigger
//      at most once per window. No entry in the last
//      ENTRY_CUTOFF_SEC of the window — triggers stay armed until the
//      cutoff. (Set ENTRY_MODE='maker' to go back to the v30 resting
//      limit at the mirror price with walk-through confirmation.)
//   3. FILL MODEL (taker): no waiting for a walk-through — the order
//      placement round-trip latency is still measured (ms, real
//      Polymarket call), and the fill is executed at the FRESH mid
//      fetched during that round-trip plus a slippage draw. Slippage
//      can be worse (crossing the book) or better (favorable mid/book
//      move) than the observed mid. Every fill pays the crypto taker
//      fee; no maker rebate.
//   4. STOP LOSS: while the window is open, any filled entry whose
//      side's mid walks down to LEADER.STOP_LOSS_PRICE (0.50) is sold
//      at 0.50 immediately (realized, no re-entry). Backtest over the
//      last 7 days of 15m windows: leaderSL50 = +$36.0k vs +$20.7k
//      without the stop (the held side that flips usually loses).
//   5. Resolution: winning side pays $1/share, losing side $0. Only
//      still-filled entries settle at resolution — stopped-out entries
//      were already realized when the stop hit.
//
//   Max exposure per window: 2 sides x 7 levels x 50 shares = 700
//   shares, up to 100 x sum(rungs) = $175 at the current level set.
//
//   FEES (per docs.polymarket.com/trading/fees + maker-rebates):
//     - Taker fee = shares x 0.07 x price x (1 - price). Takers pay
//       it on every fill (entries AND stop-loss exits). Makers never
//       pay fees and earn a 20% fee-equivalent rebate — only relevant
//       if ENTRY_MODE='maker'.
// ============================================================

module.exports = {
  // ---- Mode ----
  DEMO_MODE: true, // true = paper trading only, never places real orders
  TRADING_ENABLED: true,

  // ---- Market ----
  ASSET: 'btc', // 'btc' or 'eth' — must match Polymarket's slug prefix

  // ---- Default capital ----
  // Used when an engine doesn't set its own CAPITAL.
  STARTING_BANKROLL: 2000,

  // ---- Trigger levels ----
  // LEADER: the first time a side's price is observed at or below
  // one of these levels, buy the opposite (leader) side. Highest
  // level first; every side+level can trigger once per window.
  LADDER_RUNGS: [0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10],
  // Shares bought per trigger (fixed, regardless of dollar cost).
  // cost per trigger = RUNG_SHARES x mirror limit (e.g. 50sh @ 0.60 = $30).
  RUNG_SHARES: 50,

  // ---- Leader execution ----
  // CONFIRM_MS_MIN only matters in 'maker' mode (floor wait before
  // checking walk-through). Taker mode fills instantly on trigger.
  LEADER: {
    CONFIRM_MS_MIN: 300,
    // Stop loss: sell a filled leader entry at this price the moment
    // its side's mid walks down to it. null/undefined = no stop.
    STOP_LOSS_PRICE: 0.50,
    // No NEW entries (triggers) in the last ENTRY_CUTOFF_SEC of the
    // window — a taker buy in the final minute has no time to recover
    // and resolution is imminent. Existing positions still stop out /
    // ride to resolution. null/undefined = no cutoff.
    ENTRY_CUTOFF_SEC: 15,
    // No entries in the first ENTRY_START_SEC of the window.
    // Bot watches for 2 minutes before placing any trades.
    ENTRY_START_SEC: 120,
    // Max number of martingale rearms per window after stop loss.
    // 0 = no rearms, 1 = one rearm (50→100), 3 = up to 400 shares.
    MAX_MARTINGALE: 1,
  },

  // ---- Engines ----
  // One 5m engine with its own bankroll and history.
  // LEADER strategy on 5-minute windows.
  // no 15m engine — 5m only.
  ENGINES: {
    '5m': {
      label: '5m',
      STRATEGY: 'LEADER',
      WINDOW_MINUTES: 5,
      CAPITAL: 2000,
    },
  },

  // ---- Execution mode ----
  // 'maker' (v30): resting buy-limit at the mirror price — fill
  //   confirmed only after the leader mid walks through the limit.
  //   No fees, 20% maker rebate, but many orders expire unfilled.
  // 'taker' (v31): fill IMMEDIATELY at the leader mid with realistic
  //   slippage. Much better fill rate; every fill pays the taker fee.
  ENTRY_MODE: 'taker',

  // Taker slippage model (0–1 price units), applied to the leader-side
  // mid at execution: fillPrice = clamp(mid + slippage, 0.001, 0.999).
  // A market order usually pays the ask (worse than mid by ~half the
  // spread) but can occasionally fill better than mid when the book or
  // mid moves favorably between snapshot and execution — hence a band
  // with a small adverse bias. SLIPPAGE_MIN = best-case fill relative
  // to mid, SLIPPAGE_MAX = worst-case fill relative to mid.
  TAKER_SLIPPAGE_MIN: -0.010, // fill up to 1.0 cent better than mid
  TAKER_SLIPPAGE_MAX: 0.020,  // fill up to 2.0 cents worse than mid

  // ---- Fees & rebates (Polymarket docs, Crypto category) ----
  // Taker fee = shares x BASE_TAKER_FEE_RATE x price x (1 - price).
  // Crypto taker fee rate is 0.07; makers are never charged.
  BASE_TAKER_FEE_RATE: 0.07,
  // Maker rebate = 20% of the fee-equivalent (Crypto category).
  // Only resting (maker) fills earn it.
  MAKER_REBATE_RATE: 0.20,

  // ---- Resolution ----
  // If either side's price is observed at/above RESOLUTION_WIN_THRESHOLD
  // in the last tick sampled before the window closes, that side is
  // declared the winner immediately. Otherwise resolution falls back
  // to polling the real market price after close until it converges.
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // ---- Learn / backtest (dashboard "Learn" panel — trading unchanged) ----
  // Replays real Polymarket price history to evaluate LEADER (and the
  // historical ladder variants it replaced) so the dashboard stays
  // honest about what the strategy is worth. WINDOWS: how many PAST
  // windows to fetch per engine on refresh. LEARN_ON_BOOT: refresh
  // learn.json in the background on start.
  LEARN: {
    WINDOWS: { '5m': 48 },
    FIDELITY: 1,
    DEEP_RUNGS: [0.15, 0.10],
    TIME_FILTER_FRACTION: 0.60,
    CAP_RUNGS: 4,
    CAP_TAIL_SHARES: 25,
    TAKE_PROFIT: 0.55,
    LEARN_ON_BOOT: true,
    LEARN_MAX_AGE_MS: 30 * 60 * 1000,
    LEARN_FILE: './learn.json',
  },

  // ---- Loop timing ----
  // Polymarket's own docs confirm /midpoint allows 1,500 req/10s
  // (150/s) per IP. Polling every 500ms uses a small fraction of
  // that even with one engine x two tokens checked per tick.
  POLL_INTERVAL_MS: 500,

  // ---- Files ----
  STATE_FILE: './state.json',
};
