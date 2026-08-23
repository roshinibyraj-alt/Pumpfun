const fs = require('fs');
const config = require('./config');

function engineDefault(engineKey, engineCfg) {
  const capital = engineCfg.CAPITAL != null ? engineCfg.CAPITAL : config.STARTING_BANKROLL;
  return {
    label: engineCfg.label || engineKey,
    windowMinutes: engineCfg.WINDOW_MINUTES,
    bankroll: capital,
    startingBankroll: capital,
    currentWindow: null,
    pendingResolutions: [],
    windowHistory: [],
    lastCheck: null,
    streak: { wins: 0, losses: 0 },
    peakBankroll: capital,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    equityCurve: [],
  };
}

function defaultState() {
  return {
    engine: engineDefault('base', { CAPITAL: config.STARTING_BANKROLL, label: '15m-base' }),
    lastError: null,
    startedAt: new Date().toISOString(),
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
    if (!raw || !raw.engine) {
      return defaultState();
    }
    if (!raw.engine) raw.engine = engineDefault('base', { CAPITAL: config.STARTING_BANKROLL });
    return raw;
  } catch (e) {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
}

function saveState(state) {
  const eng = state.engine;
  if (eng) {
    if (eng.windowHistory?.length > 200) eng.windowHistory = eng.windowHistory.slice(-200);
    if (eng.equityCurve?.length > 10000) eng.equityCurve = eng.equityCurve.slice(-10000);
  }
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, defaultState };
