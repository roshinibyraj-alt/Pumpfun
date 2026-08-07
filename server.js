// ============================================================
// server.js — entry point. Serves the dashboard (public/) and
// a JSON API the dashboard polls, and starts the bot loop.
// Railway runs this file (see package.json "start" script).
// ============================================================

const express = require('express');
const path = require('path');
const config = require('./config');
const { loadState } = require('./state');
const { startBotLoop } = require('./bot');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();
  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      TRADING_ENABLED: config.TRADING_ENABLED,
      ASSET: config.ASSET,
      WINDOW_MINUTES: config.WINDOW_MINUTES,
      ORDER_SHARES: config.ORDER_SHARES,
      CHEAP_BUY_BUCKETS: config.CHEAP_BUY_BUCKETS,
      EXPENSIVE_BUY_AT_SECS: config.EXPENSIVE_BUY_AT_SECS,
      RESOLUTION_WIN_THRESHOLD: config.RESOLUTION_WIN_THRESHOLD,
    },
    ...state,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
});
