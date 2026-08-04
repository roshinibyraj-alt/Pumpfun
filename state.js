// ============================================================
// state.js — reads/writes state.json.
//
// currentWindow: the window still open, placing/filling rungs.
// pendingResolutions: windows that have closed but haven't yet
//   resolved (Polymarket settlement lags ~2 min after close) —
//   kept separate so we can keep checking them every tick without
//   blocking the new window's ladder.
// windowHistory: fully resolved windows with their aggregate
//   UP/DOWN totals and final pnl, most recent last, capped.
//
// IMPORTANT (Railway note): filesystem is ephemeral, resets on
// redeploy. Fine for now; ask if you want a persistent volume.
// ============================================================

const fs = require('fs');
const config = require('./config');

function defaultState() {
  return {
    bankroll: config.STARTING_BANKROLL,
    startingBankroll: config.STARTING_BANKROLL,
    currentWindow: null,
    pendingResolutions: [],
    windowHistory: [],
    lastCheck: null,
    lastError: null,
    startedAt: new Date().toISOString(),
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(config.STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
}

function saveState(state) {
  if (state.windowHistory && state.windowHistory.length > 200) {
    state.windowHistory = state.windowHistory.slice(-200);
  }
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, defaultState };
