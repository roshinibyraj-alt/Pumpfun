// ============================================================
// state.js — reads/writes state.json.
//
// State is organized per ENGINE ('5m' and '15m'). Each engine has:
//   bankroll / startingBankroll: its own independent capital.
//   currentWindow: the window still open, placing/filling orders.
//   pendingResolutions: windows that have closed but haven't yet
//     resolved (Polymarket settlement lags ~2 min after close) —
//     kept separate so we can keep checking them every tick without
//     blocking the new window's schedule.
//   windowHistory: fully resolved windows with their aggregate
//     UP/DOWN totals and final pnl, most recent last, capped.
//
// loadState() migrates the OLD single-engine flat shape (one shared
// bankroll/currentWindow/pendingResolutions/windowHistory) into the
// 15m engine, which is where the old 15-minute strategy lived.
//
// IMPORTANT (Railway note): filesystem is ephemeral, resets on
// redeploy. Fine for now; ask if you want a persistent volume.
// ============================================================

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
    // Bucket filter (main + mini):
    //   bucket      — main bucket: the full dollar loss of every lost
    //                 bet accumulates here.
    //   miniBucket  — the installment wagered on the next window:
    //                 bucket / BUCKET_DIVISOR at the moment a loss
    //                 happens. ONE win of a mini-bucket bet clears the
    //                 whole bucket; a loss re-splits it.
    bucket: 0,
    miniBucket: 0,
    // Streak tracker:
    //   streak — current consecutive wins and losses (one of the two
    //            is always 0; no-trade windows don't change it).
    // Peak / drawdown trackers (per engine):
    //   peakBankroll   — all-time highest resolved bankroll
    //                    (starts at the starting capital).
    //   maxDrawdown    — worst peak-to-trough decline in $ ever
    //                    recorded at a resolution.
    //   maxDrawdownPct — same drawdown as a fraction of the peak.
    // Equity curve:
    //   equityCurve — one { windowStart, bankroll } point per
    //                 resolved window (most recent last), used by
    //                 the dashboard's equity chart.
    streak: { wins: 0, losses: 0 },
    peakBankroll: capital,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    equityCurve: [],
  };
}

function defaultState() {
  const engines = {};
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    engines[key] = engineDefault(key, cfg);
  }
  return {
    engines,
    lastError: null,
    startedAt: new Date().toISOString(),
  };
}

function migrateLegacy(raw) {
  // Old single-engine shape had flat bankroll/currentWindow/
  // pendingResolutions/windowHistory. It ran 15-minute windows, so we
  // fold it into the '15m' engine.
  const state = defaultState();
  const eng = state.engines['15m'];
  if (raw.bankroll != null) {
    eng.bankroll = raw.bankroll;
    eng.startingBankroll = raw.startingBankroll != null ? raw.startingBankroll : eng.startingBankroll;
  }
  if (Array.isArray(raw.pendingResolutions)) eng.pendingResolutions = raw.pendingResolutions;
  if (Array.isArray(raw.windowHistory)) eng.windowHistory = raw.windowHistory;
  if (raw.currentWindow) eng.currentWindow = raw.currentWindow;
  if (raw.lastCheck) eng.lastCheck = raw.lastCheck;
  if (raw.lastError) state.lastError = raw.lastError;
  return state;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
    if (!raw || !raw.engines) {
      return migrateLegacy(raw || {});
    }
    // Fill any engine that's missing (e.g. new engine added later)
    // and migrate older state files that predate the streak / equity
    // curve / drawdown trackers. When the new fields are absent they
    // are backfilled from windowHistory so the dashboard stays
    // continuous across redeploys. Bucket-era fields are dropped.
    for (const [key, cfg] of Object.entries(config.ENGINES)) {
      if (!raw.engines[key]) {
        raw.engines[key] = engineDefault(key, cfg);
      } else {
        const eng = raw.engines[key];
        if (eng.bucket == null) eng.bucket = 0;
        if (eng.miniBucket == null) eng.miniBucket = 0;
        delete eng.bucketClears;
        delete eng.lastClearWins;

        const hist = Array.isArray(eng.windowHistory) ? eng.windowHistory : [];
        const capital = cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL;

        if (eng.streak == null) {
          let wins = 0, losses = 0;
          for (const w of hist) {
            if (w.traded) {
              if ((w.pnl || 0) >= 0) { wins += 1; losses = 0; }
              else { losses += 1; wins = 0; }
            }
          }
          eng.streak = { wins, losses };
        }

        if (eng.peakBankroll == null || eng.maxDrawdown == null || eng.maxDrawdownPct == null) {
          let peak = eng.startingBankroll != null ? eng.startingBankroll : capital;
          let maxDD = 0, maxPct = 0;
          for (const w of hist) {
            const b = w.bankrollAfter;
            if (b == null) continue;
            if (b > peak) peak = b;
            const dd = peak - b;
            if (dd > maxDD) { maxDD = dd; maxPct = peak > 0 ? dd / peak : 0; }
          }
          eng.peakBankroll = Math.round(peak * 100) / 100;
          eng.maxDrawdown = Math.round(maxDD * 100) / 100;
          eng.maxDrawdownPct = Math.round(maxPct * 10000) / 10000;
        }

        if (!Array.isArray(eng.equityCurve) || eng.equityCurve.length === 0) {
          eng.equityCurve = hist.map((w) => ({ windowStart: w.windowStart, bankroll: w.bankrollAfter }));
        }
      }
    }
    for (const key of Object.keys(raw.engines)) {
      if (!config.ENGINES[key]) delete raw.engines[key];
    }
    return raw;
  } catch (e) {
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
}

function saveState(state) {
  for (const eng of Object.values(state.engines || {})) {
    if (eng.windowHistory && eng.windowHistory.length > 200) {
      eng.windowHistory = eng.windowHistory.slice(-200);
    }
    if (eng.equityCurve && eng.equityCurve.length > 10000) {
      eng.equityCurve = eng.equityCurve.slice(-10000);
    }
  }
  fs.writeFileSync(config.STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, defaultState };
