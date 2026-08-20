const express = require('express');
const path = require('path');
const config = require('./config');
const { loadState } = require('./state');
const { startBotLoop, computeUnrealized } = require('./bot');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  const engines = {};
  let totalFees = 0;
  let totalRebates = 0;
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    const eng = state.engines[key] || { bankroll: 0, startingBankroll: 0, currentWindow: null, pendingResolutions: [], windowHistory: [] };
    const live = computeUnrealized(eng);
    const histFees = (eng.windowHistory || []).reduce((a, w) => a + (w.totalFees || 0), 0);
    const fees = Math.round((histFees + live.fees) * 100) / 100;
    const rebates = Math.round(live.rebates * 100) / 100;
    totalFees += fees;
    totalRebates += rebates;
    engines[key] = {
      ...eng,
      config: {
        WINDOW_MINUTES: cfg.WINDOW_MINUTES,
        PHASE1_SECONDS: config.PHASE1_SECONDS,
        PHASE1_SHARES: config.PHASE1_SHARES,
        PHASE2_SHARES: config.PHASE2_SHARES,
        BUY_INTERVAL_SEC: config.BUY_INTERVAL_SEC,
      },
      liveWindow: live,
      totalFees: fees,
      totalRebates: rebates,
    };
  }
  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      TRADING_ENABLED: config.TRADING_ENABLED,
      ASSET: config.ASSET,
      STARTING_BANKROLL: config.STARTING_BANKROLL,
      PHASE1_SECONDS: config.PHASE1_SECONDS,
      PHASE1_SHARES: config.PHASE1_SHARES,
      PHASE2_SHARES: config.PHASE2_SHARES,
      BUY_INTERVAL_SEC: config.BUY_INTERVAL_SEC,
    },
    engines,
    totalFees: Math.round(totalFees * 100) / 100,
    totalRebates: Math.round(totalRebates * 100) / 100,
    lastError: state.lastError,
    startedAt: state.startedAt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
});
