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
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    const eng = state.engines[key] || { bankroll: 0, startingBankroll: 0, currentWindow: null, pendingResolutions: [], windowHistory: [] };
    const live = computeUnrealized(eng);
    const histFees = (eng.windowHistory || []).reduce((a, w) => a + (w.totalFees || 0), 0);
    const fees = Math.round((histFees + live.fees) * 100) / 100;
    totalFees += fees;
    engines[key] = {
      label: eng.label,
      windowMinutes: eng.windowMinutes,
      bankroll: eng.bankroll,
      startingBankroll: eng.startingBankroll,
      currentWindow: eng.currentWindow ? {
        engine: eng.currentWindow.engine,
        windowStart: eng.currentWindow.windowStart,
        windowEnd: eng.currentWindow.windowEnd,
        entries: eng.currentWindow.entries,
        lastBuyAt: eng.currentWindow.lastBuyAt,
        finalUpPrice: eng.currentWindow.finalUpPrice,
        finalDownPrice: eng.currentWindow.finalDownPrice,
      } : null,
      lastCheck: eng.lastCheck,
      streak: eng.streak || { wins: 0, losses: 0 },
      peakBankroll: eng.peakBankroll,
      maxDrawdown: eng.maxDrawdown,
      maxDrawdownPct: eng.maxDrawdownPct,
      equityCurve: eng.equityCurve || [],
      windowHistory: (eng.windowHistory || []).slice(-50),
      liveWindow: live,
      totalFees: fees,
      config: {
        WINDOW_MINUTES: cfg.WINDOW_MINUTES,
        PHASE1_SECONDS: cfg.PHASE1_SECONDS,
        BUY_INTERVAL_SEC: cfg.BUY_INTERVAL_SEC,
        PHASE1_SHARES: config.PHASE1_SHARES,
        PHASE2_SHARES: config.PHASE2_SHARES,
      },
    };
  }
  res.json({
    config: { DEMO_MODE: config.DEMO_MODE, ASSET: config.ASSET },
    engines,
    totalFees: Math.round(totalFees * 100) / 100,
    lastError: state.lastError,
    startedAt: state.startedAt,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
});
