// ============================================================
// bot.js — Cheap/Expensive Phase Strategy
//
//   Phase 1 (0–180s): Buy the CHEAP side every 20s, 8 shares
//   Phase 2 (180s–window end): Buy the EXPENSIVE side every 20s, 15 shares
//
//   Both 5m and 15m engines run independently.
//   Hold positions until window resolution ($1 win / $0 loss).
//   No stop loss, no martingale, no anti-whipsaw filters.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

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
    side,
    tokenId,
    shares,
    fillPrice,
    fillFee: round5(feeEquiv),
    filledAt: new Date().toISOString(),
    entryReason: reason,
    status: 'filled',
    resolvedWon: null,
    exitPrice: null,
    cost: null,
    payout: null,
    pnl: null,
    settledAt: null,
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
    return {
      entries: [],
      totalCost: 0,
      totalShares: 0,
      unrealizedPnL: 0,
      fees: 0,
      rebates: 0,
      upShares: 0,
      downShares: 0,
      upCost: 0,
      downCost: 0,
    };
  }
  const win = engine.currentWindow;
  let totalCost = 0, totalShares = 0, unrealizedPnL = 0, fees = 0, rebates = 0;
  let upShares = 0, downShares = 0, upCost = 0, downCost = 0;
  for (const e of win.entries) {
    if (e.status === 'filled') {
      const cost = e.shares * e.fillPrice;
      totalCost += cost;
      totalShares += e.shares;
      fees += e.fillFee || 0;
      rebates += e.fillRebate || 0;
      if (e.side === 'UP') { upShares += e.shares; upCost += cost; }
      else { downShares += e.shares; downCost += cost; }
    }
  }
  return {
    entries: win.entries.filter(e => e.status === 'filled'),
    totalCost: round2(totalCost),
    totalShares,
    unrealizedPnL: round2(unrealizedPnL),
    fees: round2(fees),
    rebates: round2(rebates),
    upShares,
    downShares,
    upCost: round2(upCost),
    downCost: round2(downCost),
  };
}

// Determine cheap vs expensive side
function getCheapExpensive(upPrice, downPrice) {
  if (upPrice == null || downPrice == null) return null;
  if (upPrice < downPrice) return { cheap: 'UP', expensive: 'DOWN', cheapPrice: upPrice, expensivePrice: downPrice };
  if (downPrice < upPrice) return { cheap: 'DOWN', expensive: 'UP', cheapPrice: downPrice, expensivePrice: upPrice };
  return null; // equal — skip
}

async function resolveWindow(engine, engineCfg, win, tag) {
  const hist = win.entries.filter(e => e.status === 'filled');
  let totalCost = 0, totalPayout = 0, totalFees = 0;

  for (const e of hist) {
    totalCost += e.shares * e.fillPrice;
    totalFees += e.fillFee || 0;
    let won = false;
    if (e.side === 'UP' && win.finalUpPrice != null && win.finalUpPrice >= config.RESOLUTION_WIN_THRESHOLD) won = true;
    if (e.side === 'DOWN' && win.finalDownPrice != null && win.finalDownPrice >= config.RESOLUTION_WIN_THRESHOLD) won = true;
    e.resolvedWon = won;
    e.status = won ? 'resolved_win' : 'resolved_loss';
    e.payout = won ? e.shares : 0;
    e.cost = e.shares * e.fillPrice;
    e.pnl = e.payout - e.cost - (e.fillFee || 0);
    e.exitPrice = won ? 1.0 : 0;
    e.settledAt = new Date().toISOString();
    totalPayout += e.payout;
  }

  const netPnl = totalPayout - totalCost - totalFees;
  const state = loadState();
  const eng = state.engines[engine];

  eng.bankroll = round2((eng.bankroll || 0) + netPnl);
  eng.peakBankroll = Math.max(eng.peakBankroll || 0, eng.bankroll);
  const dd = eng.peakBankroll - eng.bankroll;
  const ddPct = eng.peakBankroll > 0 ? dd / eng.peakBankroll : 0;
  if (dd > (eng.maxDrawdown || 0)) eng.maxDrawdown = round2(dd);
  if (ddPct > (eng.maxDrawdownPct || 0)) eng.maxDrawdownPct = round5(ddPct);

  if (netPnl >= 0) { eng.streak.wins += 1; eng.streak.losses = 0; }
  else { eng.streak.losses += 1; eng.streak.wins = 0; }

  eng.windowHistory.push({
    windowStart: win.windowStart,
    entries: hist.length,
    totalCost: round2(totalCost),
    totalPayout: round2(totalPayout),
    totalFees: round2(totalFees),
    pnl: round2(netPnl),
    bankrollAfter: eng.bankroll,
    traded: true,
  });
  if (eng.windowHistory.length > 200) eng.windowHistory = eng.windowHistory.slice(-200);

  eng.equityCurve.push({ windowStart: win.windowStart, bankroll: eng.bankroll });
  if (eng.equityCurve.length > 10000) eng.equityCurve = eng.equityCurve.slice(-10000);

  const result = netPnl >= 0 ? 'WIN' : 'LOSS';
  log(`${tag} RESOLVED ${result}: ${hist.length} entries, cost $${totalCost.toFixed(2)}, payout $${totalPayout.toFixed(2)}, fees $${totalFees.toFixed(2)}, PnL $${netPnl.toFixed(2)}, bankroll $${eng.bankroll.toFixed(2)}`);

  saveState(state);
}

async function engineTick(state, engineKey, engineCfg, nowSec) {
  const tag = `[${engineKey}]`;
  const engine = state.engines[engineKey];
  if (!engine) return;

  // Resolve pending windows
  while (engine.pendingResolutions && engine.pendingResolutions.length > 0) {
    const pending = engine.pendingResolutions.shift();
    try {
      await resolveWindow(engine, engineCfg, pending, tag);
    } catch (e) {
      log(`${tag} ERROR resolving window:`, e.message);
      state.lastError = e.message;
    }
  }

  // Find current live market
  let marketInfo = null;
  try {
    marketInfo = await polymarket.getCurrentUpDownMarket(config.ASSET, engineCfg.WINDOW_MINUTES);
  } catch (e) {
    log(`${tag} ERROR fetching market:`, e.message);
    state.lastError = e.message;
    return;
  }

  if (!marketInfo) {
    if (!engine.noMarketSuppressedAt || nowSec - engine.noMarketSuppressedAt >= 60) {
      engine.noMarketSuppressedAt = nowSec;
      log(`${tag} No live ${engineCfg.WINDOW_MINUTES}m market found.`);
    }
    return;
  }

  const { market, windowStart, windowEnd } = marketInfo;
  const { upTokenId, downTokenId } = polymarket.parseTokens(market);

  // New window opened?
  if (!engine.currentWindow || engine.currentWindow.windowStart !== windowStart) {
    if (engine.currentWindow && engine.currentWindow.windowStart !== windowStart) {
      if (engine.currentWindow.entries.length > 0) {
        engine.pendingResolutions.push(engine.currentWindow);
      }
    }
    engine.currentWindow = {
      engine: engineKey,
      windowStart,
      windowEnd,
      entries: [],
      lastBuyAt: 0,
      finalUpPrice: null,
      finalDownPrice: null,
    };
    log(`${tag} Window ${windowStart} opened (${engineCfg.WINDOW_MINUTES}m)`);
  }

  // Fetch prices
  const [upPrice, downPrice] = await Promise.all([
    polymarket.getMidpoint(upTokenId),
    polymarket.getMidpoint(downTokenId),
  ]);

  engine.lastCheck = {
    timestamp: new Date().toISOString(),
    windowStart,
    windowEnd,
    secondsRemaining: windowEnd - nowSec,
    upPrice,
    downPrice,
  };

  const win = engine.currentWindow;
  if (!win || nowSec >= windowEnd) return;

  // Snapshot prices for resolution
  win.finalUpPrice = upPrice;
  win.finalDownPrice = downPrice;

  // Check buy interval
  const elapsed = nowSec - windowStart;
  if (elapsed - win.lastBuyAt < config.BUY_INTERVAL_SEC) return;

  const sideInfo = getCheapExpensive(upPrice, downPrice);
  if (!sideInfo) return;

  let buySide, buyPrice, shares, reason;
  if (elapsed < config.PHASE1_SECONDS) {
    // Phase 1: buy cheap side
    buySide = sideInfo.cheap;
    buyPrice = sideInfo.cheapPrice;
    shares = config.PHASE1_SHARES;
    reason = `PHASE1 cheap ${buySide} @ $${buyPrice.toFixed(3)} t=${elapsed}s`;
  } else {
    // Phase 2: buy expensive side
    buySide = sideInfo.expensive;
    buyPrice = sideInfo.expensivePrice;
    shares = config.PHASE2_SHARES;
    reason = `PHASE2 expensive ${buySide} @ $${buyPrice.toFixed(3)} t=${elapsed}s`;
  }

  if (config.TRADING_ENABLED && !config.DEMO_MODE) {
    // Real order would go here — not implemented for safety
    log(`${tag} LIVE ORDER SKIPPED (demo only)`);
  }

  const fillPrice = applySlippage(buyPrice);
  fireEntry(win, buySide, shares, fillPrice, upTokenId, downTokenId, reason);
  win.lastBuyAt = elapsed;
}

const engineNoMarketSuppressedAt = {};
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const state = loadState();
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, cfg] of Object.entries(config.ENGINES)) {
      try {
        await engineTick(state, key, cfg, nowSec);
      } catch (e) {
        log(`[${key}] ERROR:`, e.message);
        state.lastError = e.message;
      }
    }
    saveState(state);
  } finally {
    tickRunning = false;
  }
}

function startBotLoop() {
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}m windows). Capital: $${cfg.CAPITAL} | Phase1: buy cheap ${config.PHASE1_SHARES}sh every ${config.BUY_INTERVAL_SEC}s for ${config.PHASE1_SECONDS}s | Phase2: buy expensive ${config.PHASE2_SHARES}sh every ${config.BUY_INTERVAL_SEC}s | hold to resolution`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
