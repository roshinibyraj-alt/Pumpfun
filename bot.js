// ============================================================
// bot.js — Cheap/Expensive Phase Strategy (proportional intervals)
//
//   Phase 1 (0–Xs): Buy CHEAP side, 8sh per entry
//   Phase 2 (X–Ys): Buy EXPENSIVE side, 15sh per entry
//   After Ys: No trades, hold to resolution
//   5m:  120s/240s/20s.  15m: 360s/720s/60s.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const { loadState, saveState } = require('./state');

function log(...args) { console.log(new Date().toISOString(), '-', ...args); }
function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }

function applySlippage(mid) {
  if (mid == null) return null;
  const min = config.TAKER_SLIPPAGE_MIN != null ? config.TAKER_SLIPPAGE_MIN : 0;
  const max = config.TAKER_SLIPPAGE_MAX != null ? config.TAKER_SLIPPAGE_MAX : 0;
  const slip = min + Math.random() * (max - min);
  return Math.min(0.999, Math.max(0.001, Math.round((mid + slip) * 1000) / 1000));
}

function makeEntry(side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const tokenId = side === 'UP' ? upTokenId : downTokenId;
  const feeEquiv = shares * config.BASE_TAKER_FEE_RATE * fillPrice * (1 - fillPrice);
  return {
    side, tokenId, shares, fillPrice,
    fillFee: round5(feeEquiv),
    filledAt: new Date().toISOString(),
    entryReason: reason,
    status: 'filled',
    resolvedWon: null, exitPrice: null, cost: null,
    payout: null, pnl: null, settledAt: null,
  };
}

function fireEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const entry = makeEntry(side, shares, fillPrice, upTokenId, downTokenId, reason);
  win.entries.push(entry);
  log(`[${win.engine}] ENTRY: ${side} ${shares}sh @ $${fillPrice.toFixed(3)} ($${(shares * fillPrice).toFixed(2)}) | ${reason}`);
  return entry;
}

function computeUnrealized(engine) {
  if (!engine || !engine.currentWindow) {
    return { entries: [], totalCost: 0, totalShares: 0, unrealizedPnL: 0, fees: 0,
      upShares: 0, downShares: 0, upCost: 0, downCost: 0, upUnrealized: 0, downUnrealized: 0 };
  }
  const win = engine.currentWindow;
  const lc = engine.lastCheck || {};
  const upPrice = lc.upPrice || 0, downPrice = lc.downPrice || 0;
  let totalCost = 0, totalShares = 0, fees = 0;
  let upShares = 0, downShares = 0, upCost = 0, downCost = 0;
  let upUnrealized = 0, downUnrealized = 0;
  for (const e of win.entries) {
    if (e.status === 'filled') {
      const cost = e.shares * e.fillPrice;
      totalCost += cost; totalShares += e.shares; fees += e.fillFee || 0;
      if (e.side === 'UP') { upShares += e.shares; upCost += cost; upUnrealized += e.shares * upPrice - cost; }
      else { downShares += e.shares; downCost += cost; downUnrealized += e.shares * downPrice - cost; }
    }
  }
  return {
    entries: win.entries.filter(e => e.status === 'filled'),
    totalCost: round2(totalCost), totalShares,
    unrealizedPnL: round2(upUnrealized + downUnrealized),
    upUnrealized: round2(upUnrealized), downUnrealized: round2(downUnrealized),
    fees: round2(fees), upShares, downShares, upCost: round2(upCost), downCost: round2(downCost),
  };
}

function getCheapExpensive(upPrice, downPrice) {
  if (upPrice == null || downPrice == null) return null;
  if (upPrice < downPrice) return { cheap: 'UP', expensive: 'DOWN', cheapPrice: upPrice, expensivePrice: downPrice };
  if (downPrice < upPrice) return { cheap: 'DOWN', expensive: 'UP', cheapPrice: downPrice, expensivePrice: upPrice };
  return null;
}

function resolveWindow(eng, engineCfg, win, tag) {
  const filled = win.entries.filter(e => e.status === 'filled');
  if (filled.length === 0) { log(`${tag} RESOLVED NO_TRADE: window ${win.windowStart}`); return; }
  let totalCost = 0, totalPayout = 0, totalFees = 0;
  for (const e of filled) {
    const cost = e.shares * e.fillPrice;
    totalCost += cost; totalFees += e.fillFee || 0;
    let won = false;
    if (e.side === 'UP' && win.finalUpPrice != null && win.finalUpPrice >= config.RESOLUTION_WIN_THRESHOLD) won = true;
    if (e.side === 'DOWN' && win.finalDownPrice != null && win.finalDownPrice >= config.RESOLUTION_WIN_THRESHOLD) won = true;
    e.resolvedWon = won; e.status = won ? 'resolved_win' : 'resolved_loss';
    e.payout = won ? e.shares : 0; e.cost = cost;
    e.pnl = e.payout - cost - (e.fillFee || 0); e.exitPrice = won ? 1.0 : 0;
    e.settledAt = new Date().toISOString(); totalPayout += e.payout;
  }
  const netPnl = totalPayout - totalCost - totalFees;
  eng.bankroll = round2((eng.bankroll || 0) + netPnl);
  eng.peakBankroll = Math.max(eng.peakBankroll || 0, eng.bankroll);
  const dd = eng.peakBankroll - eng.bankroll;
  const ddPct = eng.peakBankroll > 0 ? dd / eng.peakBankroll : 0;
  if (dd > (eng.maxDrawdown || 0)) eng.maxDrawdown = round2(dd);
  if (ddPct > (eng.maxDrawdownPct || 0)) eng.maxDrawdownPct = round5(ddPct);
  if (netPnl >= 0) { eng.streak.wins += 1; eng.streak.losses = 0; }
  else { eng.streak.losses += 1; eng.streak.wins = 0; }

  const upE = filled.filter(e => e.side === 'UP'), downE = filled.filter(e => e.side === 'DOWN');
  eng.windowHistory.push({
    windowStart: win.windowStart, entries: filled.length,
    upShares: upE.reduce((a, e) => a + e.shares, 0),
    downShares: downE.reduce((a, e) => a + e.shares, 0),
    upCost: round2(upE.reduce((a, e) => a + e.shares * e.fillPrice, 0)),
    downCost: round2(downE.reduce((a, e) => a + e.shares * e.fillPrice, 0)),
    upPayout: round2(upE.reduce((a, e) => a + (e.payout || 0), 0)),
    downPayout: round2(downE.reduce((a, e) => a + (e.payout || 0), 0)),
    totalCost: round2(totalCost), totalPayout: round2(totalPayout), totalFees: round2(totalFees),
    finalUpPrice: win.finalUpPrice, finalDownPrice: win.finalDownPrice,
    pnl: round2(netPnl), bankrollAfter: eng.bankroll, traded: true, settledAt: new Date().toISOString(),
  });
  if (eng.windowHistory.length > 200) eng.windowHistory = eng.windowHistory.slice(-200);
  eng.equityCurve.push({ windowStart: win.windowStart, bankroll: eng.bankroll });
  if (eng.equityCurve.length > 10000) eng.equityCurve = eng.equityCurve.slice(-10000);
  log(`${tag} RESOLVED ${netPnl >= 0 ? 'WIN' : 'LOSS'}: ${filled.length} entries, UP ${upE.reduce((a,e)=>a+e.shares,0)}sh / DOWN ${downE.reduce((a,e)=>a+e.shares,0)}sh, cost $${totalCost.toFixed(2)}, payout $${totalPayout.toFixed(2)}, PnL $${netPnl.toFixed(2)}, bankroll $${eng.bankroll.toFixed(2)}`);
}

async function engineTick(state, engineKey, engineCfg, nowSec) {
  const tag = `[${engineKey}]`;
  const engine = state.engines[engineKey];
  if (!engine) return;

  while (engine.pendingResolutions && engine.pendingResolutions.length > 0) {
    const pending = engine.pendingResolutions.shift();
    try { resolveWindow(engine, engineCfg, pending, tag); }
    catch (e) { log(`${tag} ERROR resolving:`, e.message); state.lastError = e.message; }
  }

  let marketInfo = null;
  try { marketInfo = await polymarket.getCurrentUpDownMarket(config.ASSET, engineCfg.WINDOW_MINUTES); }
  catch (e) { log(`${tag} ERROR market:`, e.message); state.lastError = e.message; return; }

  if (!marketInfo) {
    if (engine.currentWindow && nowSec >= engine.currentWindow.windowEnd) {
      try { resolveWindow(engine, engineCfg, engine.currentWindow, tag); }
      catch (e) { log(`${tag} ERROR resolving:`, e.message); }
      engine.currentWindow = null;
    }
    if (!engine.noMarketSuppressedAt || nowSec - engine.noMarketSuppressedAt >= 60) {
      engine.noMarketSuppressedAt = nowSec;
      log(`${tag} No live ${engineCfg.WINDOW_MINUTES}m market.`);
    }
    return;
  }

  const { market, windowStart, windowEnd } = marketInfo;
  const { upTokenId, downTokenId } = polymarket.parseTokens(market);

  if (!engine.currentWindow || engine.currentWindow.windowStart !== windowStart) {
    if (engine.currentWindow) {
      const old = engine.currentWindow;
      if (old.finalUpPrice == null || old.finalDownPrice == null) {
        try {
          const [u, d] = await Promise.all([polymarket.getMidpoint(upTokenId), polymarket.getMidpoint(downTokenId)]);
          old.finalUpPrice = u; old.finalDownPrice = d;
        } catch (_) {}
      }
      if (old.entries.length > 0) {
        log(`${tag} Window ${old.windowStart} closed (${old.entries.length} entries) → resolving`);
        resolveWindow(engine, engineCfg, old, tag);
      }
    }
    engine.currentWindow = {
      engine: engineKey, windowStart, windowEnd,
      entries: [], lastBuyAt: 0, finalUpPrice: null, finalDownPrice: null,
    };
    log(`${tag} Window ${windowStart} opened (${engineCfg.WINDOW_MINUTES}m)`);
  }

  const [upPrice, downPrice] = await Promise.all([
    polymarket.getMidpoint(upTokenId), polymarket.getMidpoint(downTokenId),
  ]);

  engine.lastCheck = {
    timestamp: new Date().toISOString(), windowStart, windowEnd,
    secondsRemaining: windowEnd - nowSec, upPrice, downPrice,
  };

  const win = engine.currentWindow;
  if (!win) return;

  if (nowSec < windowEnd) {
    win.finalUpPrice = upPrice;
    win.finalDownPrice = downPrice;

    const elapsed = nowSec - windowStart;
    const phase1End = engineCfg.PHASE1_SECONDS || 120;
    const phase2End = engineCfg.PHASE2_SECONDS || 240;
    const interval = engineCfg.BUY_INTERVAL_SEC || 20;

    // Only trade during phase 1 or phase 2
    if (elapsed < phase2End && (elapsed - win.lastBuyAt >= interval)) {
      const sideInfo = getCheapExpensive(upPrice, downPrice);
      if (sideInfo) {
        let buySide, buyPrice, shares, reason;
        if (elapsed < phase1End) {
          buySide = sideInfo.cheap; buyPrice = sideInfo.cheapPrice; shares = config.PHASE1_SHARES;
          reason = `PHASE1 cheap ${buySide} @ $${buyPrice.toFixed(3)} t=${elapsed}s`;
        } else {
          buySide = sideInfo.expensive; buyPrice = sideInfo.expensivePrice; shares = config.PHASE2_SHARES;
          reason = `PHASE2 expensive ${buySide} @ $${buyPrice.toFixed(3)} t=${elapsed}s`;
        }
        const fillPrice = applySlippage(buyPrice);
        fireEntry(win, buySide, shares, fillPrice, upTokenId, downTokenId, reason);
        win.lastBuyAt = elapsed;
      }
    }
  } else {
    win.finalUpPrice = upPrice;
    win.finalDownPrice = downPrice;
    if (win.entries.length > 0) {
      log(`${tag} Window ended → resolving UP=$${upPrice.toFixed(3)} DOWN=$${downPrice.toFixed(3)}`);
      resolveWindow(engine, engineCfg, win, tag);
    }
    engine.currentWindow = null;
  }
}

let tickRunning = false;
async function tick() {
  if (tickRunning) return; tickRunning = true;
  try {
    const state = loadState();
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, cfg] of Object.entries(config.ENGINES)) {
      try { await engineTick(state, key, cfg, nowSec); }
      catch (e) { log(`[${key}] ERROR:`, e.message); state.lastError = e.message; }
    }
    saveState(state);
  } finally { tickRunning = false; }
}

function startBotLoop() {
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    log(`Bot started — ${key} (${cfg.WINDOW_MINUTES}m). $${cfg.CAPITAL} | Phase1: 0–${cfg.PHASE1_SECONDS}s cheap ${config.PHASE1_SHARES}sh/${cfg.BUY_INTERVAL_SEC}s | Phase2: ${cfg.PHASE1_SECONDS}–${cfg.PHASE2_SECONDS}s expensive ${config.PHASE2_SHARES}sh/${cfg.BUY_INTERVAL_SEC}s | Hold after ${cfg.PHASE2_SECONDS}s`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
