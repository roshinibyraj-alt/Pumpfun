// ============================================================
// CONFIG — cheap/expensive phase strategy
//
//   Phase 1 (0–Xs): Buy the CHEAP side, 8 shares per entry
//   Phase 2 (X–end): Buy the EXPENSIVE side, 15 shares per entry
//
//   5m engine:  180s phase1, 20s interval
//   15m engine: 540s phase1, 60s interval (3x of 5m)
//   Same share sizes on both. Hold until resolution.
// ============================================================

module.exports = {
  DEMO_MODE: true,
  TRADING_ENABLED: true,
  ASSET: 'btc',
  STARTING_BANKROLL: 2000,

  // Shares per entry (same for both engines)
  PHASE1_SHARES: 8,
  PHASE2_SHARES: 15,

  // Engines — fully independent capital, intervals, and history
  // 15m gets 3x time intervals vs 5m, same share sizes
  ENGINES: {
    '5m': {
      label: '5m',
      WINDOW_MINUTES: 5,
      CAPITAL: 2000,
      PHASE1_SECONDS: 180,
      BUY_INTERVAL_SEC: 20,
    },
    '15m': {
      label: '15m',
      WINDOW_MINUTES: 15,
      CAPITAL: 2000,
      PHASE1_SECONDS: 540,
      BUY_INTERVAL_SEC: 60,
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
