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
      CANDLE_INTERVAL: config.CANDLE_INTERVAL,
      CANDLE_LOOKBACK: config.CANDLE_LOOKBACK,
      ENTRY_WAIT_SECONDS: config.ENTRY_WAIT_SECONDS,
      EARLY_ENTRY_TRIGGER_PRICE: config.EARLY_ENTRY_TRIGGER_PRICE,
      RESOLUTION_WIN_THRESHOLD: config.RESOLUTION_WIN_THRESHOLD,
      ORDER_NOTIONAL_USD: config.ORDER_NOTIONAL_USD,
    },
    ...state,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
});
