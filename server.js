// ============================================================
// server.js — entry point. Serves the dashboard (public/) and
// a JSON API the dashboard polls, and starts the bot loop.
// Railway runs this file (see package.json "start" script).
// ============================================================

const fs = require('fs');
const express = require('express');
const path = require('path');
const config = require('./config');
const { loadState } = require('./state');
const { startBotLoop, computeUnrealized } = require('./bot');
const { runLearn } = require('./learn');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const state = loadState();

  // Per-engine live marks + aggregates.
  const engines = {};
  let totalFees = 0;
  let totalRebates = 0;
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    const eng = state.engines[key] || { bankroll: 0, startingBankroll: 0, currentWindow: null, pendingResolutions: [], windowHistory: [] };
    const live = computeUnrealized(eng);
    const histFees = (eng.windowHistory || []).reduce((a, w) => a + (w.totalFees || 0), 0);
    const histRebates = (eng.windowHistory || []).reduce((a, w) => a + (w.totalRebates || 0), 0);
    const fees = Math.round((histFees + live.fees) * 100) / 100;
    const rebates = Math.round((histRebates + live.rebates) * 100) / 100;
    totalFees += fees;
    totalRebates += rebates;
    engines[key] = {
      ...eng,
      config: {
        STRATEGY: cfg.STRATEGY,
        WINDOW_MINUTES: cfg.WINDOW_MINUTES,
        LADDER_RUNGS: config.LADDER_RUNGS,
        RUNG_SHARES: config.RUNG_SHARES,
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
      BASE_TAKER_FEE_RATE: config.BASE_TAKER_FEE_RATE,
      MAKER_REBATE_RATE: config.MAKER_REBATE_RATE,
      ENTRY_IS_MAKER: config.ENTRY_IS_MAKER,
      LADDER_RUNGS: config.LADDER_RUNGS,
      RUNG_SHARES: config.RUNG_SHARES,
      RESOLUTION_WIN_THRESHOLD: config.RESOLUTION_WIN_THRESHOLD,
    },
    engines,
    totalFees: Math.round(totalFees * 100) / 100,
    totalRebates: Math.round(totalRebates * 100) / 100,
    lastError: state.lastError,
    startedAt: state.startedAt,
  });
});

app.get('/api/learn', (req, res) => {
  try {
    const raw = fs.readFileSync(config.LEARN.LEARN_FILE, 'utf8');
    res.json({ found: true, data: JSON.parse(raw) });
  } catch (_) {
    res.json({ found: false, data: null });
  }
});

// Refresh the learn backtest in the background if it's missing or
// older than LEARN_MAX_AGE_MS. Never blocks the dashboard.
function maybeRefreshLearn() {
  if (!config.LEARN.LEARN_ON_BOOT) return;
  const file = config.LEARN.LEARN_FILE;
  let stale = true;
  try {
    const st = fs.statSync(file);
    stale = Date.now() - st.mtimeMs > config.LEARN.LEARN_MAX_AGE_MS;
  } catch (_) {}
  if (stale) {
    console.log('Learn: refreshing backtest in the background…');
    runLearn()
      .then((s) => console.log(`Learn: refresh done — ${Object.entries(s.engines).map(([k, v]) => `${k} ${v.windows} windows`).join(', ')}`))
      .catch((e) => console.error('Learn: refresh failed:', e.message));
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
  startBotLoop();
  maybeRefreshLearn();
});
