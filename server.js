const express = require('express');
const path = require('path');
const config = require('./config');
const { loadState } = require('./state');
const { startBotLoop, computeUnrealized } = require('./bot');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  const eng = state.engine || { bankroll: 0, startingBankroll: 0, currentWindow: null, pendingResolutions: [], windowHistory: [] };
  const live = computeUnrealized(eng);
  res.json({ demoMode: config.DEMO_MODE, asset: config.ASSET,
    engine: { label: '15m-base', bankroll: eng.bankroll, startingBankroll: eng.startingBankroll,
      currentWindow: eng.currentWindow, lastCheck: eng.lastCheck,
      streak: eng.streak, peakBankroll: eng.peakBankroll, maxDrawdown: eng.maxDrawdown,
      equityCurve: (eng.equityCurve||[]).slice(-500), windowHistory: (eng.windowHistory||[]).slice(-50),
      live }, totalFees: live.fees });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Dashboard running on port ${PORT}`); startBotLoop(); });
