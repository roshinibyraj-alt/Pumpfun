// ============================================================
// state.js — reads/writes state.json. This is our entire
// "database": bankroll, open position, and trade history.
//
// IMPORTANT (Railway note): Railway's filesystem is ephemeral —
// it resets on every redeploy. That's fine for now while you're
// testing the strategy, but before you care about long demo
// runs, ask me to wire this up to a Railway volume or a tiny
// Postgres/SQLite add-on so history survives redeploys.
// ============================================================

const fs = require('fs');
const config = require('./config');

function defaultState() {
  return {
    bankroll: config.STARTING_BANKROLL,
    startingBankroll: config.STARTING_BANKROLL,
    openPosition: null, // { windowStart, windowEnd, side, price, stake, strike }
    trades: [], // completed trades, most recent last
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
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, defaultState };
