// ============================================================
// bot.js — v26. ONE unified engine shape (5m only, 15m removed).
// The ONLY live strategy is LEADER (see config.js):
//
//   5m — LEADER (buy the non-dipping side):
//     When a side's mid price is first observed AT OR BELOW a trigger
//     level (0.40 -> 0.10), the bot places a resting buy-limit order
//     on the OPPOSITE (leader) side at the MIRROR of the dipped level
//     — a $0.40 dip places the limit at exactly $0.60, $0.35 -> $0.65,
//     ... $0.10 -> $0.90 (50 fixed shares per trigger, cost = 50 x
//     limit price). Each side+level can trigger once per window;
//     triggers stay armed until the window closes (no cutoff).
//
//     FILL CONFIRMATION: fills are NOT assumed. Order placement
//     latency is measured in ms with a real Polymarket round-trip;
//     only after that latency has elapsed does the bot check that the
//     price walked through the order price (leader mid <= limit). The
//     fill is then confirmed at the limit price as a maker fill.
//     Orders that never walk through expire unfilled at window close.
//
//   TRACKERS (per engine):
//     - streak: current consecutive wins / losses.
//     - peakBankroll / maxDrawdown / maxDrawdownPct: all-time peak
//       capital and the worst peak-to-trough decline recorded.
//     - equityCurve: one realized-equity point per resolved window.
//
// FEES & REBATES (docs.polymarket.com/trading/fees + maker-rebates):
//   Crypto: taker fee = shares x 0.07 x price x (1 - price).
//   Makers never pay fees; crypto maker rebate = 20% of the
//   fee-equivalent, only for resting (maker) fills.
//   Confirmed LEADER fills are RESTING (maker) fills: fee 0, 20%
//   rebate credited (config.ENTRY_IS_MAKER=true).
//
// Live marks: every tick we snapshot both sides' midpoints; the
// dashboard uses them (via computeUnrealized) to show real-time
// unrealized P&L on every open position.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }

function priceOf(side, upPrice, downPrice) {
  return side === 'UP' ? upPrice : downPrice;
}

// Builds an ALREADY-FILLED entry at the moment a ladder rung fills.
// Rungs are RESTING buy limits: they fill AT the rung's limit price
// (not the current midpoint) as maker fills.
function makeEntry(side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const tokenId = side === 'UP' ? upTokenId : downTokenId;
  const feeEquiv = shares * config.BASE_TAKER_FEE_RATE * fillPrice * (1 - fillPrice);
  const isMaker = !!config.ENTRY_IS_MAKER;
  return {
    side,
    tokenId,
    shares,
    fillPrice,
    fillFee: isMaker ? 0 : round5(feeEquiv),
    fillRebate: isMaker ? round5(feeEquiv * config.MAKER_REBATE_RATE) : 0,
    filledAt: new Date().toISOString(),
    entryReason: reason,
    status: 'filled', // filled -> stopped_out | resolved_win | resolved_loss
    resolvedWon: null,
    exitPrice: null,
    cost: null,
    payout: null,
    pnl: null,
    settledAt: null,
  };
}

// Records a buy on win.entries.
function fireEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const entry = makeEntry(side, shares, fillPrice, upTokenId, downTokenId, reason);
  win.entries.push(entry);
  log(`[${win.engine || '?'}] ENTRY: ${side} ${shares}sh @ $${fillPrice.toFixed(2)} ($${(shares * fillPrice).toFixed(2)} notional) | fee $${entry.fillFee.toFixed(4)} | rebate $${entry.fillRebate.toFixed(4)} — ${reason}`);
  return entry;
}

// Checks whether the window's LAST observed tick (closest snapshot to
// windowEnd — see win.finalUpPrice/finalDownPrice, updated every tick)
// already shows a side at/above the win threshold.
function immediateWinnerFromLastTick(win) {
  if (win.finalUpPrice != null && win.finalUpPrice >= config.RESOLUTION_WIN_THRESHOLD) return 'UP';
  if (win.finalDownPrice != null && win.finalDownPrice >= config.RESOLUTION_WIN_THRESHOLD) return 'DOWN';
  return null;
}

// Attempts to resolve a closed window. First checks whether the last
// tick sampled before the window closed already showed a side at/above
// RESOLUTION_WIN_THRESHOLD — if so, that side is declared the winner
// immediately with no extra network call. Otherwise falls back to
// polling the real market price (no fallback beyond that — waits if
// still ambiguous).
//
// Entries already stopped out (status 'stopped_out') were settled and
// credited to the bankroll when the stop hit — only still-'filled'
// entries are settled here (win = $1/share, lose = $0; rebate credited
// to payout when present). The window totals include every entry.
//
// After settling, the streak, peak capital / max drawdown, and equity
// curve trackers are updated.
// Returns true if resolved this call, false if still waiting.
async function resolveWindow(engine, win) {
  let wonSide = immediateWinnerFromLastTick(win);

  if (!wonSide) {
    let upTokenPrice;
    try {
      upTokenPrice = await polymarket.getMidpoint(win.upTokenId);
    } catch (e) {
      log(`ERROR checking resolution for window ${win.windowStart}:`, e.message);
      return false;
    }

    if (upTokenPrice >= config.RESOLUTION_WIN_THRESHOLD) wonSide = 'UP';
    else if (upTokenPrice <= config.RESOLUTION_LOSS_THRESHOLD) wonSide = 'DOWN';
    else return false; // not converged yet, try again next tick
  }

  const entries = win.entries || [];
  let cost = 0, payout = 0, fees = 0, rebates = 0, settleCredit = 0;
  let resolvedWin = false; // any entry settled as a win this call
  const traded = entries.length > 0;

  // LEADER: any order that never had its fill confirmed by the time
  // the window closed is not a position — mark it expired (no cost).
  for (const o of win.orders || []) {
    if (o.status === 'placed') {
      o.status = 'expired';
      o.expiredAt = new Date().toISOString();
      log(`[${win.engine}] LEADER ORDER EXPIRED ${o.side} ${o.shares}sh @ $${o.price.toFixed(2)} (${o.triggerSide} dipped to $${o.triggerLevel.toFixed(2)}) — price never walked through the limit`);
    }
  }

  for (const pos of entries) {
    const f = pos.fillFee || 0;
    const r = pos.fillRebate || 0;
    fees += f;
    rebates += r;

    if (pos.pnl == null) {
      // Not settled yet (stop loss never hit) — settle against wonSide.
      pos.resolvedWon = pos.side === wonSide;
      pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
      pos.cost = Math.round((pos.shares * pos.fillPrice + f) * 100000) / 100000;
      pos.payout = Math.round((pos.resolvedWon ? pos.shares : 0) * 100000) / 100000 + r;
      pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
      pos.settledAt = new Date().toISOString();
      settleCredit += pos.pnl;
      if (pos.pnl >= 0) {
        resolvedWin = true;
      }
    }
    cost += pos.cost;
    payout += pos.payout;
  }

  if (settleCredit !== 0) {
    engine.bankroll = Math.round((engine.bankroll + settleCredit) * 100) / 100;
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  const isLoss = traded ? pnl < 0 : null;

  // Streak tracker: consecutive wins / losses (only traded windows
  // count; no-trade windows leave the streak untouched).
  if (traded) {
    if (pnl >= 0) {
      engine.streak.wins += 1;
      engine.streak.losses = 0;
    } else {
      engine.streak.losses += 1;
      engine.streak.wins = 0;
    }
  }

  // Peak capital + max drawdown trackers (resolved bankroll only).
  if (engine.bankroll > engine.peakBankroll) {
    engine.peakBankroll = Math.round(engine.bankroll * 100) / 100;
  }
  const dd = Math.max(0, engine.peakBankroll - engine.bankroll);
  if (dd > engine.maxDrawdown) {
    engine.maxDrawdown = Math.round(dd * 100) / 100;
    engine.maxDrawdownPct = Math.round((dd / engine.peakBankroll) * 10000) / 10000;
    log(`[${win.engine}] MAX DRAWDOWN ${engine.maxDrawdownPct * 100}% ($${engine.maxDrawdown.toFixed(2)}) from peak $${engine.peakBankroll.toFixed(2)}`);
  }

  // Equity curve: one realized-equity point per resolved window.
  engine.equityCurve.push({
    windowStart: win.windowStart,
    bankroll: engine.bankroll,
    resolvedAt: new Date().toISOString(),
  });
  if (engine.equityCurve.length > 10000) engine.equityCurve = engine.equityCurve.slice(-10000);

  engine.windowHistory.push({
    engine: win.engine,
    windowMinutes: win.windowMinutes,
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    signal: win.signal,
    entries,
    entryCount: entries.length,
    sides: entries.map((e) => e.side),
    wonSide,
    traded,
    totalFees: Math.round(fees * 100000) / 100000,
    totalRebates: Math.round(rebates * 100000) / 100000,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    isLoss,
    bankrollAfter: engine.bankroll,
    triggerCount: entries.length,
    leaderNotional: Math.round(cost * 100) / 100,
    peakBankrollAfter: engine.peakBankroll,
    maxDrawdownAfter: engine.maxDrawdown,
    maxDrawdownPctAfter: engine.maxDrawdownPct,
    streakAfter: { wins: engine.streak.wins, losses: engine.streak.losses },
    resolvedAt: new Date().toISOString(),
  });

  log(
    `[${win.engine}] WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | ${entries.length} entries (${entries.map((e) => e.side).join(', ') || 'none'}) | payout $${payout.toFixed(2)} | cost $${cost.toFixed(2)} | fees $${fees.toFixed(5)} | rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | bankroll $${engine.bankroll}`
  );
  return true;
}

// Computes live unrealized P&L for one engine's open window using the
// latest midpoint snapshot (engine.lastCheck). Only still-'filled'
// entries are marked to market; stopped-out entries carry their final
// realized pnl. Used by the dashboard's /api/state.
function computeUnrealized(engine) {
  const win = engine.currentWindow;
  const lc = engine.lastCheck || {};
  const out = {
    upPrice: lc.upPrice != null ? lc.upPrice : null,
    downPrice: lc.downPrice != null ? lc.downPrice : null,
    entries: [],
    costBasis: 0,
    currentValue: 0,
    unrealizedPnl: 0,
    fees: 0,
    rebates: 0,
  };
  if (win && Array.isArray(win.entries)) {
  for (const e of win.entries) {
    const cur = e.side === 'UP' ? lc.upPrice : lc.downPrice;
    const fee = e.fillFee || 0;
    const rebate = e.fillRebate || 0;

    if (e.status === 'filled') {
      const cost = e.shares * e.fillPrice + fee;
      const value = cur != null ? e.shares * cur : cost;
      out.costBasis += cost;
      out.currentValue += value;
      out.unrealizedPnl += value - cost;
      out.fees += fee;
      out.rebates += rebate;
      out.entries.push({
        side: e.side,
        shares: e.shares,
        fillPrice: e.fillPrice,
        currentPrice: cur != null ? cur : null,
        fee: round5(fee),
        rebate: round5(rebate),
        cost: round5(cost),
        value: round5(value),
        unrealizedPnl: cur != null ? round5(value - cost) : null,
        entryReason: e.entryReason,
        status: e.status,
      });
    } else {
      // stopped_out — realized already; surface the final numbers.
      out.entries.push({
        side: e.side,
        shares: e.shares,
        fillPrice: e.fillPrice,
        currentPrice: e.exitPrice,
        fee: round5(fee),
        rebate: round5(rebate),
        cost: e.cost,
        value: e.payout,
        unrealizedPnl: e.pnl,
        entryReason: e.entryReason,
        status: e.status,
      });
    }
  }
  }
  out.costBasis = round2(out.costBasis);
  out.currentValue = round2(out.currentValue);
  out.unrealizedPnl = round2(out.unrealizedPnl);
  out.fees = round2(out.fees);
  out.rebates = round2(out.rebates);

  // LEADER trigger summary for the dashboard (placed/confirmed/expired).
  const orders = (win && Array.isArray(win.orders)) ? win.orders : [];
  out.triggers = {
    levels: (config.LADDER_RUNGS || []).length * 2,
    placed: orders.filter((o) => o.status === 'placed').length,
    filled: orders.filter((o) => o.status === 'filled').length,
    expired: orders.filter((o) => o.status === 'expired').length,
    lastLatencyMs: win ? win.lastLatencyMs : null,
    orders: orders
      .map((o) => ({ side: o.side, triggerSide: o.triggerSide, triggerLevel: o.triggerLevel, price: o.price, shares: o.shares, status: o.status, measuredLatencyMs: o.measuredLatencyMs }))
      .sort((a, b) => b.triggerLevel - a.triggerLevel || (a.triggerSide < b.triggerSide ? -1 : 1)),
  };
  return out;
}

// ---- engines (5m & 15m): DIP_RECOVERY (pure dip signal, no SL) ----
// Places the two resting buy-limit ladders (UP + DOWN) on a fresh
// window. One order per rung per side; each buys a FIXED number of
// shares (RUNG_SHARES, default 50), resting at the rung price. Called
// ---- LEADER engine (5m only): buy the NON-dipping side ----
// When a side's mid is first observed at or below a trigger level,
// place a buy-limit order on the OPPOSITE (leader) side at the MIRROR
// of the dipped level (0.40 -> 0.60, ... 0.10 -> 0.90). Each
// side+level can trigger once per window. The order placement
// round-trip is timed with a real Polymarket call (ms) and the fill
// is only confirmed after that latency once the price has walked
// through the limit price.
async function placeLeaderOrder(engine, win, triggerSide, level, leaderSide, leaderPx, upTokenId, downTokenId, tag) {
  const shares = config.RUNG_SHARES;
  const leaderTokenId = leaderSide === 'UP' ? upTokenId : downTokenId;

  // The leader-side buy-limit rests at the MIRROR of the dipped
  // level: a $0.40 dip places the limit at exactly $0.60, $0.35 ->
  // $0.65, ... $0.10 -> $0.90. The fill is confirmed at that limit
  // price when the leader mid walks through it — never marked lower.
  const limitPrice = Math.round((1 - level) * 100) / 100;

  // Measure the order-placement round-trip latency (ms) with a real
  // Polymarket call — in demo mode the midpoint fetch is the closest
  // proxy for "how long placing an order takes".
  const t0 = Date.now();
  let freshPx = leaderPx;
  try {
    freshPx = await polymarket.getMidpoint(leaderTokenId);
  } catch (_) {}
  const latencyMs = Date.now() - t0;
  win.lastLatencyMs = latencyMs;
  const order = {
    side: leaderSide,
    triggerSide,
    triggerLevel: level,
    price: limitPrice,
    rawMid: freshPx,
    shares,
    status: 'placed', // placed -> filled | expired
    placedAt: new Date().toISOString(),
    placedAtMs: Date.now(),
    measuredLatencyMs: latencyMs,
    confirmAtMs: Date.now() + Math.max(latencyMs, config.LEADER.CONFIRM_MS_MIN),
    filledAt: null,
    expiredAt: null,
    entryRef: null,
  };
  win.orders.push(order);
  log(`${tag} LEADER ORDER placed — ${triggerSide} dipped to $${level.toFixed(2)} -> buy ${leaderSide} ${shares}sh @ $${limitPrice.toFixed(2)} (mid $${freshPx.toFixed(3)}) | order latency ${latencyMs}ms, fill confirmed after price walks through`);
}

// Marks confirmed fills for orders whose placement latency has elapsed
// and whose leader-side price has walked through the limit price.
function confirmLeaderFills(engine, win, tag, upPrice, downPrice, upTokenId, downTokenId) {
  const nowMs = Date.now();
  for (const order of win.orders) {
    if (order.status !== 'placed') continue;
    if (nowMs < order.confirmAtMs) continue; // placement still settling
    const cur = priceOf(order.side, upPrice, downPrice);
    if (cur == null) continue;
    if (cur > order.price) continue; // price hasn't walked through yet
    order.status = 'filled';
    order.filledAt = new Date().toISOString();
    const entry = fireEntry(win, order.side, order.shares, order.price, upTokenId, downTokenId,
      `LEADER flip — ${order.triggerSide} dipped to $${order.triggerLevel.toFixed(2)} → buy ${order.side} @ $${order.price.toFixed(2)} (walk-through confirmed, order latency ${order.measuredLatencyMs}ms)`);
    order.entryRef = entry;
    log(`${tag} LEADER FILL CONFIRMED ${order.side} ${order.shares}sh @ $${order.price.toFixed(2)} — price walked through the limit (latency ${order.measuredLatencyMs}ms)`);
  }
}

// One strategy tick for a live window: arm new triggers, then confirm
// pending fills.
async function leaderTick(engine, win, engineCfg, tag, upPrice, downPrice, upTokenId, downTokenId) {
  const rungs = (config.LADDER_RUNGS || []).slice().sort((a, b) => b - a);
  win.triggered = win.triggered || {};

  // Process UP first, then DOWN; within a side highest level first.
  for (const triggerSide of ['UP', 'DOWN']) {
    const px = priceOf(triggerSide, upPrice, downPrice);
    if (px == null) continue;
    for (const level of rungs) {
      if (px > level) break; // above this level and all lower ones
      const key = triggerSide + ':' + level;
      if (win.triggered[key]) continue;
      const leaderSide = triggerSide === 'UP' ? 'DOWN' : 'UP';
      const leaderPx = priceOf(leaderSide, upPrice, downPrice);
      if (leaderPx == null) continue;
      win.triggered[key] = true;
      await placeLeaderOrder(engine, win, triggerSide, level, leaderSide, leaderPx, upTokenId, downTokenId, tag);
    }
  }

  confirmLeaderFills(engine, win, tag, upPrice, downPrice, upTokenId, downTokenId);
}

async function engineTick(state, engineKey, engineCfg, nowSec) {
  const engine = state.engines[engineKey];
  const tag = `[${engineKey}]`;

  // 1) Hand off the current window for resolution the moment its time
  //    is up — BEFORE we look at creating the next window.
  try {
    if (engine.currentWindow && nowSec >= engine.currentWindow.windowEnd) {
      engine.pendingResolutions.push(engine.currentWindow);
      log(`${tag} Window ${engine.currentWindow.windowStart} closed -> pending resolution`);
      engine.currentWindow = null;
    }
  } catch (e) {
    log(`${tag} ERROR handing off closed window:`, e.message);
    state.lastError = e.message;
  }

  // 2) Resolution pass — isolated in its own try/catch so a hiccup
  //    here can't block the rest of the engine tick.
  try {
    const stillPending = [];
    for (const win of engine.pendingResolutions) {
      const resolved = await resolveWindow(engine, win);
      if (!resolved) stillPending.push(win);
    }
    engine.pendingResolutions = stillPending;
    if (!state.lastError) state.lastError = null;
  } catch (e) {
    log(`${tag} ERROR in resolution pass:`, e.message);
    state.lastError = e.message;
  }

  // 3) Market snapshot, new-window creation, and the strategy step.
  try {
    const found = await polymarket.getCurrentUpDownMarket(config.ASSET, engineCfg.WINDOW_MINUTES);

    if (found) {
      const { market, windowStart, windowEnd } = found;
      const { upTokenId, downTokenId } = polymarket.parseTokens(market);

      if (!engine.currentWindow || engine.currentWindow.windowStart !== windowStart) {
        // Safety net: if for some reason step 1 didn't already catch
        // a stale window, hand it off here too.
        if (engine.currentWindow) {
          engine.pendingResolutions.push(engine.currentWindow);
          log(`${tag} Window ${engine.currentWindow.windowStart} closed -> pending resolution (late detection)`);
        }

        engine.currentWindow = {
          engine: engineKey,
          windowMinutes: engineCfg.WINDOW_MINUTES,
          strategy: engineCfg.STRATEGY,
          windowStart,
          windowEnd,
          upTokenId,
          downTokenId,
          signal: `${engineCfg.STRATEGY}_${engineKey}`,
          entries: [],
          orders: [],
          triggered: {},
          lastLatencyMs: null,
          finalUpPrice: null,
          finalDownPrice: null,
        };

        log(`${tag} Window ${windowStart} opened — LEADER: when a side dips to $${(config.LADDER_RUNGS || []).map(p => p.toFixed(2)).join(', $')} buy the opposite side ${config.RUNG_SHARES}sh @ the mirror limit ($${(config.LADDER_RUNGS || []).map(p => (1 - p).toFixed(2)).join(', $')}) | fill confirmed after price walks through | live until window close | peak $${engine.peakBankroll.toFixed(2)}`);
      }

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

      if (win && nowSec < windowEnd) {
        await leaderTick(engine, win, engineCfg, tag, upPrice, downPrice, upTokenId, downTokenId);

        // Snapshot both sides' prices on every tick while the window is
        // still open. Whichever snapshot ends up closest to windowEnd is
        // what resolveWindow() treats as "the last second of the window".
        win.finalUpPrice = upPrice;
        win.finalDownPrice = downPrice;
      }
    } else if (!engineNoMarketSuppressedAt[engineKey] || nowSec - engineNoMarketSuppressedAt[engineKey] >= 60) {
      engineNoMarketSuppressedAt[engineKey] = nowSec;
      log(`${tag} No live ${engineCfg.WINDOW_MINUTES}m market found for current window yet.`);
    }
  } catch (e) {
    log(`${tag} ERROR taking live snapshot / checking current window:`, e.message);
    state.lastError = e.message;
  }

  // 4) Extra safety net: in case the current window's time ran out
  //    again during step 3 (e.g. a slow network call straddled the
  //    boundary), catch it here too rather than waiting a full extra
  //    poll interval.
  try {
    if (engine.currentWindow && nowSec >= engine.currentWindow.windowEnd) {
      engine.pendingResolutions.push(engine.currentWindow);
      engine.currentWindow = null;
    }
  } catch (e) {
    log(`${tag} ERROR handing off closed window (late):`, e.message);
    state.lastError = e.message;
  }
}

const engineNoMarketSuppressedAt = {};

let tickRunning = false;
async function tick() {
  if (tickRunning) return; // never overlap async ticks — a slow network call
  tickRunning = true;
  try {
    const state = loadState();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const [key, cfg] of Object.entries(config.ENGINES)) {
      try {
        await engineTick(state, key, cfg, nowSec);
      } catch (e) {
        log(`[${key}] ERROR in engine tick:`, e.message);
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
    const rungs = (config.LADDER_RUNGS || []).map((p) => '$' + p.toFixed(2)).join(' / ');
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}-min windows, ${cfg.STRATEGY}). Bankroll: $${cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL} | LEADER: dip to ${rungs} -> buy opposite side ${config.RUNG_SHARES}sh @ mirror limit (dip $0.40 -> $0.60 ... $0.10 -> $0.90) | fill confirmed after price walks through (latency measured) | maker fills (20% rebate) | no cutoff`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized, leaderTick };
