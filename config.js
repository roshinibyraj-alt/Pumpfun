// ============================================================
// CONFIG — cheap/expensive phase strategy (proportional intervals)
//
//   5m:  Phase1 0–120s (cheap), Phase2 120–240s (expensive), 240–300s hold
//   15m: Phase1 0–360s (cheap), Phase2 360–720s (expensive), 720–900s hold
//   Same share sizes. No trades in final 60s(5m)/180s(15m).
// ============================================================

module.exports = {
  DEMO_MODE: true,
  TRADING_ENABLED: true,
  ASSET: 'btc',
  STARTING_BANKROLL: 2000,

  PHASE1_SHARES: 8,
  PHASE2_SHARES: 15,

  ENGINES: {
    '5m': {
      label: '5m',
      WINDOW_MINUTES: 5,
      CAPITAL: 2000,
      PHASE1_SECONDS: 120,
      PHASE2_SECONDS: 240,
      BUY_INTERVAL_SEC: 20,
    },
    '15m': {
      label: '15m',
      WINDOW_MINUTES: 15,
      CAPITAL: 2000,
      PHASE1_SECONDS: 360,
      PHASE2_SECONDS: 720,
      BUY_INTERVAL_SEC: 60,
    },
  },

  ENTRY_MODE: 'taker',
  TAKER_SLIPPAGE_MIN: -0.010,
  TAKER_SLIPPAGE_MAX: 0.020,
  BASE_TAKER_FEE_RATE: 0.07,
  MAKER_REBATE_RATE: 0.20,
  RESOLUTION_WIN_THRESHOLD: 0.90,
  RESOLUTION_LOSS_THRESHOLD: 0.10,
  POLL_INTERVAL_MS: 500,
  STATE_FILE: './state.json',
};
