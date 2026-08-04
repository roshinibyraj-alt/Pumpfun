// ============================================================
// state.js — reads/writes state.json. Now tracks a ladder of
// independent rungs per window instead of a single position.
//
// IMPORTANT (Railway note): Railway's filesystem is ephemeral —
// resets on every redeploy. Fine for now; ask if you want this
// wired to a persistent volume later.
// ============================================================

const fs = require('fs');
const config = require('./config');

function defaultState() {
  return {
    bankroll: config.STARTING_BANKROLL,
    startingBankroll: config.STARTING_BANKROLL,
    activeRungs: [], // rungs for the current window still in play
    completedRungs: [], // finished rungs (locked or resolved), most recent last, capped
    lastCheck: null, // latest snapshot info for the dashboard (window, prices, countdown)
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
  // cap completedRungs so state.json doesn't grow unbounded
  if (state.completedRungs && state.completedRungs.length > 500) {
    state.completedRungs = state.completedRungs.slice(-500);
  }
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, defaultState };
