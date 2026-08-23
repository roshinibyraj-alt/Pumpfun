const config = require('./config');
const polymarket = require('./polymarket');
const { loadState, saveState } = require('./state');

function log(...args) { console.log(new Date().toISOString(), '-', ...args); }
function r2(n) { return Math.round(n * 100) / 100; }
function r5(n) { return Math.round(n * 100000) / 100000; }

function applySlippage(mid) {
  if (mid == null) return null;
  const min = config.TAKER_SLIPPAGE_MIN || 0;
  const max = config.TAKER_SLIPPAGE_MAX || 0;
  return Math.min(0.999, Math.max(0.001, Math.round((mid + min + Math.random() * (max - min)) * 1000) / 1000));
}

function makeEntry(side, shares, fillPrice, tokenId, reason) {
  const feeEquiv = shares * config.BASE_TAKER_FEE_RATE * fillPrice * (1 - fillPrice);
  return { side, tokenId, shares, fillPrice, fillFee: r5(feeEquiv), filledAt: new Date().toISOString(),
    reason, status: 'filled', resolvedWon: null, exitPrice: null, cost: null, payout: null, pnl: null, settledAt: null };
}

function fireEntry(win, side, shares, fillPrice, tokenId, reason) {
  const entry = makeEntry(side, shares, fillPrice, tokenId, reason);
  win.entries.push(entry);
  log(`ENTRY: ${side} ${shares}sh @ $${fillPrice.toFixed(3)} | ${reason}`);
}

function computeUnrealized(engine) {
  if (!engine || !engine.currentWindow) return { entries: [], totalCost: 0, totalShares: 0, unrealizedPnL: 0, fees: 0, upShares: 0, downShares: 0, upCost: 0, downCost: 0, upUnrealized: 0, downUnrealized: 0 };
  const win = engine.currentWindow, lc = engine.lastCheck || {};
  const upPrice = lc.up15m || lc.upPrice || 0, downPrice = lc.down15m || lc.downPrice || 0;
  let totalCost = 0, totalShares = 0, fees = 0, upSh = 0, dnSh = 0, upC = 0, dnC = 0, upU = 0, dnU = 0;
  for (const e of win.entries) {
    if (e.status !== 'filled') continue;
    const cost = e.shares * e.fillPrice; totalCost += cost; totalShares += e.shares; fees += e.fillFee || 0;
    if (e.side === 'UP') { upSh += e.shares; upC += cost; upU += e.shares * upPrice - cost; }
    else { dnSh += e.shares; dnC += cost; dnU += e.shares * downPrice - cost; }
  }
  return { entries: win.entries.filter(e => e.status === 'filled'), totalCost: r2(totalCost), totalShares,
    unrealizedPnL: r2(upU + dnU), upUnrealized: r2(upU), downUnrealized: r2(dnU),
    fees: r2(fees), upShares: upSh, downShares: dnSh, upCost: r2(upC), downCost: r2(dnC) };
}

function resolveEntries(entries, finalUp, finalDown) {
  let totalPayout = 0, totalCost = 0, totalFees = 0;
  for (const e of entries) {
    const cost = e.shares * e.fillPrice;
    totalCost += cost; totalFees += e.fillFee || 0;
    const won = e.side === 'UP' ? finalUp >= config.RESOLUTION_WIN_THRESHOLD : finalDown >= config.RESOLUTION_WIN_THRESHOLD;
    e.resolvedWon = won; e.status = won ? 'resolved_win' : 'resolved_loss';
    e.payout = won ? e.shares : 0; e.cost = cost;
    e.pnl = e.payout - cost - (e.fillFee || 0); e.exitPrice = won ? 1.0 : 0;
    e.settledAt = new Date().toISOString(); totalPayout += e.payout;
  }
  return { netPnl: totalPayout - totalCost - totalFees, totalPayout, totalCost, totalFees };
}

function resolveWindow(eng, win) {
  const filled = win.entries.filter(e => e.status === 'filled');
  if (!filled.length) { log(`RESOLVED NO_TRADE: ${win.windowStart}`); return; }
  const result = resolveEntries(filled, win.finalUpPrice ?? 0, win.finalDownPrice ?? 0);
  eng.bankroll = r2((eng.bankroll || 0) + result.netPnl);
  eng.peakBankroll = Math.max(eng.peakBankroll || eng.startingBankroll, eng.bankroll);
  const dd = eng.peakBankroll - eng.bankroll, ddPct = eng.peakBankroll > 0 ? dd / eng.peakBankroll : 0;
  eng.maxDrawdown = Math.max(eng.maxDrawdown || 0, dd); eng.maxDrawdownPct = Math.max(eng.maxDrawdownPct || 0, ddPct);
  if (result.netPnl > 0) eng.streak.wins++; else eng.streak.losses++;
  eng.equityCurve.push({ t: Date.now(), equity: eng.bankroll });
  eng.windowHistory.push({ windowStart: win.windowStart, entries: filled.length, pnl: r2(result.netPnl),
    bankrollAfter: eng.bankroll, sides: filled.map(e => `${e.side}:${e.shares}sh`).join('+') });
  log(`RESOLVED — PnL $${result.netPnl.toFixed(2)} (${filled.length} entries) → bankroll $${eng.bankroll}`);
}

async function engineTick(state, nowSec) {
  const eng = state.engine; if (!eng) return;
  while (eng.pendingResolutions?.length > 0) {
    const pending = eng.pendingResolutions.shift();
    resolveWindow(eng, pending);
  }
  const baseInfo = await polymarket.getCurrentUpDownMarket(config.ASSET, config.BASE_WINDOW_MINUTES).catch(() => null);
  if (!baseInfo) { if (eng.currentWindow && nowSec >= eng.currentWindow.windowEnd) { resolveWindow(eng, eng.currentWindow); eng.currentWindow = null; } return; }
  const { market: baseMarket, windowStart: baseStart, windowEnd: baseEnd } = baseInfo;
  const baseTokens = polymarket.parseTokens(baseMarket);

  // Determine which 5m sub-window we're in
  const subWindowSec = 300;
  const elapsedInBase = nowSec - baseStart;
  const subIndex = Math.floor(elapsedInBase / subWindowSec); // 0,1,2 for first/second/third
  const subStart = baseStart + subIndex * subWindowSec;
  const subEnd = subStart + subWindowSec;

  // Discover 5m market for current sub-window
  let subMarket = null;
  try { subMarket = await polymarket.getCurrentUpDownMarket(config.ASSET, 5); } catch (_) {}
  const subTokens = subMarket ? polymarket.parseTokens(subMarket.market) : null;

  // Initialize new base window
  if (!eng.currentWindow || eng.currentWindow.baseStart !== baseStart) {
    if (eng.currentWindow) {
      const old = eng.currentWindow;
      if (old.entries.length > 0) resolveWindow(eng, old);
    }
    eng.currentWindow = { baseStart, baseEnd, entries: [], hedgeState: 'initial', lastSubResolvedWon: null, activeSubIndex: -1 };
    log(`🆕 BASE WINDOW t=${baseStart} (15m)`);
  }
  const win = eng.currentWindow; if (!win) return;

  // Fetch prices
  const [up15, down15] = await Promise.all([
    polymarket.getMidpoint(baseTokens.upTokenId).catch(() => null),
    polymarket.getMidpoint(baseTokens.downTokenId).catch(() => null),
  ]);
  let up5 = null, down5 = null;
  if (subTokens) [up5, down5] = await Promise.all([
    polymarket.getMidpoint(subTokens.upTokenId).catch(() => null),
    polymarket.getMidpoint(subTokens.downTokenId).catch(() => null),
  ]);

  eng.lastCheck = { timestamp: new Date().toISOString(), elapsed: elapsedInBase, subIndex,
    secondsRemaining: baseEnd - nowSec, up15m: up15, down15m: down15, up5m: up5, down5m: down5,
    hedgeState: win.hedgeState, baseStart, baseEnd };

  // Check if sub-window ended and resolve hedge
  if (win.activeSubIndex >= 0 && subIndex !== win.activeSubIndex && win.activeSubIndex < 2) {
    const hedgeEntry = win.entries.find(e => e.side === 'DOWN' && e.subIndex === win.activeSubIndex && e.status === 'filled');
    if (hedgeEntry) {
      const won = hedgeEntry.fillPrice != null && down5 != null && down5 >= config.RESOLUTION_WIN_THRESHOLD;
      hedgeEntry.resolvedWon = won; hedgeEntry.status = won ? 'resolved_win' : 'resolved_loss';
      hedgeEntry.pnl = (won ? hedgeEntry.shares : 0) - hedgeEntry.cost;
      win.lastSubResolvedWon = won;
      log(`SUB-WINDOW #${win.activeSubIndex + 1} DOWN ${won ? 'WON' : 'LOST'}`);
      if (won && win.activeSubIndex === 0) win.hedgeState = 'rearm_sub2';
      else win.hedgeState = 'idle';
    } else { win.lastSubResolvedWon = null; win.hedgeState = 'idle'; }
  }

  // Strategy execution
  if (nowSec < baseEnd) {
    win.finalUpPrice = up15; win.finalDownPrice = down15;

    // Phase 1: t=0 in base window → buy UP 150sh + DOWN 50sh on sub-window #1
    if (elapsedInBase < 10 && !win.entries.some(e => e.side === 'UP')) {
      const fill = applySlippage(up15 ?? 0.50);
      fireEntry(win, 'UP', config.BASE_UP_SHARES, fill, baseTokens.upTokenId, `BASE UP 150sh @${fill.toFixed(3)} t=${elapsedInBase}s`);
      win.baseUpFired = true;
    }

    if (elapsedInBase < 10 && subTokens && !win.entries.some(e => e.side === 'DOWN')) {
      const fill = applySlippage(down5 ?? 0.50);
      fireEntry(win, 'DOWN', config.HEDGE_SHARES, fill, subTokens.downTokenId, `HEDGE#1 DOWN 50sh @${fill.toFixed(3)} t=${elapsedInBase}s`);
      win.activeSubIndex = 0;
    }

    // Phase 2: after sub-window #1 won → re-hedge on sub-window #2
    if (win.hedgeState === 'rearm_sub2' && subIndex === 1 && subTokens && !win.entries.some(e => e.side === 'DOWN' && e.subIndex === 1)) {
      const fill = applySlippage(down5 ?? 0.50);
      fireEntry(win, 'DOWN', config.HEDGE_SHARES, fill, subTokens.downTokenId, `HEDGE#2 DOWN 50sh @${fill.toFixed(3)} t=${elapsedInBase}s`);
      win.activeSubIndex = 1;
      win.hedgeState = 'holding_sub2';
    }
    // No trades on third sub-window — no action needed
  } else {
    win.finalUpPrice = up15; win.finalDownPrice = down15;
    if (win.entries.some(e => e.status === 'filled')) resolveWindow(eng, win);
    eng.currentWindow = null;
  }
}

let tickRunning = false;
async function tick() {
  if (tickRunning) return; tickRunning = true;
  try {
    const state = loadState();
    await engineTick(state, Math.floor(Date.now() / 1000));
    saveState(state);
  } catch (e) { log('ERROR:', e.message); }
  finally { tickRunning = false; }
}

function startBotLoop() {
  log(`Bot started — 15m base + 3×5m hedges | UP ${config.BASE_UP_SHARES}sh + DOWN ${config.HEDGE_SHARES}sh per hedge | DEMO:${config.DEMO_MODE}`);
  tick(); setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
