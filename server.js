// ============================================================
// server.js — entry point. Serves the dashboard (public/) and
// a JSON API the dashboard polls, and starts the bot loop.
// Railway runs this file (see package.json "start" script).
// ============================================================

const express = require('express');
const path = require('path');
const config = require('./config');
const { loadState } = require('./state');
const { startBotLoop, computeUnrealized } = require('./bot');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  const liveWindow = computeUnrealized(state);
  const histFees = (state.windowHistory || []).reduce((a, w) => a + (w.totalFees || 0), 0);
  const histRebates = (state.windowHistory || []).reduce((a, w) => a + (w.totalRebates || 0), 0);
  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      TRADING_ENABLED: config.TRADING_ENABLED,
      ASSET: config.ASSET,
      WINDOW_MINUTES: config.WINDOW_MINUTES,
      ORDER_SHARES: config.ORDER_SHARES,
      CHEAP_BUY_AT_SECS: config.CHEAP_BUY_AT_SECS,
      EXPENSIVE_BUY_AT_SECS: config.EXPENSIVE_BUY_AT_SECS,
      BASE_TAKER_FEE_RATE: config.BASE_TAKER_FEE_RATE,
      MAKER_REBATE_RATE: config.MAKER_REBATE_RATE,
      ENTRY_IS_MAKER: config.ENTRY_IS_MAKER,
      RESOLUTION_WIN_THRESHOLD: config.RESOLUTION_WIN_THRESHOLD,
    },
    ...state,
    liveWindow,
    totalFees: Math.round((histFees + liveWindow.fees) * 100) / 100,
    totalRebates: Math.round((histRebates + liveWindow.rebates) * 100) / 100,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
});
