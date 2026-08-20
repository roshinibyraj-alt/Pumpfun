// ============================================================
// CONFIG — cheap/expensive phase strategy
//
//   Phase 1 (0–180s): Buy the CHEAP side every 20s, 8 shares
//   Phase 2 (180s–window end): Buy the EXPENSIVE side every 20s, 15 shares
//
//   Both 5m and 15m engines follow same logic.
//   No stop loss, no martingale, no anti-whipsaw filters.
//   Hold until window resolution ($1 win / $0 loss).
// ============================================================

module.exports = {
  DEMO_MODE: true,
  TRADING_ENABLED: true,
  ASSET: 'btc',
  STARTING_BANKROLL: 2000,

  // Strategy params
  PHASE1_SECONDS: 180,
  PHASE1_SHARES: 8,
  PHASE2_SHARES: 15,
  BUY_INTERVAL_SEC: 20,

  // Engines — fully independent capital and history
  ENGINES: {
    '5m': {
      label: '5m',
      WINDOW_MINUTES: 5,
      CAPITAL: 2000,
    },
    '15m': {
      label: '15m',
      WINDOW_MINUTES: 15,
      CAPITAL: 2000,
    },
  },

  // Execution
  ENTRY_MODE: 'taker',
  TAKER_SLIPPAGE_MIN: -0.010,
  TAKER_SLIPPAGE_MAX: 0.020,
  BASE_TAKER_FEE_RATE: 0.07,
  MAKER_REBATE_RATE: 0.20,

  // Resolution
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,

  // Loop
  POLL_INTERVAL_MS: 500,
  STATE_FILE: './state.json',
};
