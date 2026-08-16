// ============================================================
// bot.js — v25. ONE unified engine shape (5m and 15m), each with its
// own bankroll, current window, pending resolutions, and history.
// Both engines run the SAME DUAL_LADDER strategy (see config.js):
//
//   5m / 15m — DUAL_LADDER (resting limit orders only):
//     As soon as a window opens, place TWO resting buy-limit ladders
//     immediately — one for UP, one for DOWN — with rungs at 0.40,
//     0.35, 0.30, 0.25, 0.20, 0.15 and 0.10, 50 fixed shares per
//     rung (cost = 50 x rung price, filled at the rung price).
//     CROSS-CANCEL RULE: when a rung fills on one side, the opposite
//     side's SAME-PRICE rung is cancelled; every other rung stays
//     live. No monitoring phase, no cutoff — rungs rest until the
//     window closes. Filled shares ride to resolution: winner pays
//     $1/share, loser pays $0; unfilled rungs cost nothing.
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
//   All ladder fills are RESTING (maker) fills: fee 0, 20% rebate
//   credited (config.ENTRY_IS_MAKER=true).
//
// Live marks: every tick we snapshot both sides' midpoints; the
// dashboard uses them (via computeUnrealized) to show real-time
// unrealized P&L on every open position, per engine.
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
    ladderFills: entries.length,
    ladderNotional: Math.round(cost * 100) / 100,
    // FULL-ROUND WIN (skip-filter learning): all ladder rungs filled
    // in this window AND the window settled with P&L >= 0.
    fullRound: traded && entries.length === (config.LADDER_RUNGS || []).length,
    fullRoundWon: traded && entries.length === (config.LADDER_RUNGS || []).length && pnl >= 0,
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

  // Ladder summary for the dashboard (resting rungs + fills).
  const orders = (win && Array.isArray(win.orders)) ? win.orders : [];
  out.ladder = {
    placed: win ? !!win.laddersPlaced : false,
    total: orders.length,
    filled: orders.filter((o) => o.status === 'filled').length,
    cancelled: orders.filter((o) => o.status === 'cancelled').length,
    open: orders.filter((o) => o.status === 'open').length,
    notionalFilled: round2(orders.filter((o) => o.status === 'filled').reduce((a, o) => a + o.shares * o.price, 0)),
    rungs: orders
      .filter((o) => o.status === 'filled' || o.status === 'cancelled')
      .map((o) => ({ side: o.side, price: o.price, status: o.status }))
      .sort((a, b) => b.price - a.price || (a.side < b.side ? -1 : 1)),
  };
  return out;
}

// ---- engines (5m & 15m): DIP_RECOVERY (pure dip signal, no SL) ----
// Places the two resting buy-limit ladders (UP + DOWN) on a fresh
// window. One order per rung per side; each buys a FIXED number of
// shares (RUNG_SHARES, default 50), resting at the rung price. Called
// once, the moment the window is first seen.
function placeLadders(win, engineCfg) {
  const rungs = (engineCfg.LADDER_RUNGS && engineCfg.LADDER_RUNGS.length ? engineCfg.LADDER_RUNGS : config.LADDER_RUNGS).slice().sort((a, b) => b - a);
  const shares = engineCfg.RUNG_SHARES != null ? engineCfg.RUNG_SHARES : config.RUNG_SHARES;
  win.orders = [];
  for (const side of ['UP', 'DOWN']) {
    for (const price of rungs) {
      win.orders.push({
        side,
        price,
        shares,
        status: 'open', // open -> filled | cancelled
        filledAt: null,
        cancelledAt: null,
      });
    }
  }
  win.laddersPlaced = true;
  const maxCost = 2 * shares * rungs.reduce((a, p) => a + p, 0);
  log(`[${win.engine}] LADDERS PLACED ${win.windowStart} — ${rungs.map((p) => '$' + p.toFixed(2)).join(' / ')} × ${shares}sh × UP+DOWN (${win.orders.length} resting orders, max $${maxCost.toFixed(0)}/window) | maker fills | live until window close`);
}

// One strategy tick for a live window. A resting buy limit at price P
// fills the moment the observed mid price trades AT or BELOW P; the
// fill happens AT the limit price P (maker fill). All crossed rungs on
// a side fill in the same tick (highest price first). Immediately
// after a fill, the opposite side's SAME-PRICE rung is cancelled.
// Rungs keep resting until window close — there is no cutoff time.
function ladderTick(engine, win, engineCfg, tag, upPrice, downPrice, upTokenId, downTokenId) {
  if (!win.laddersPlaced) placeLadders(win, engineCfg);

  const orderBy = {};
  for (const o of win.orders) orderBy[o.side + ':' + o.price] = o;

  // Process UP first, then DOWN; within a side highest rung first, so
  // the cross-cancel rule resolves deterministically even if both
  // sides appear fillable in the same tick.
  for (const side of ['UP', 'DOWN']) {
    const px = priceOf(side, upPrice, downPrice);
    if (px == null) continue;
    const rungs = win.orders.filter((o) => o.side === side && o.status === 'open').map((o) => o.price).sort((a, b) => b - a);
    for (const price of rungs) {
      if (px > price) break; // mid above this rung and all lower ones
      const order = orderBy[side + ':' + price];
      if (!order || order.status !== 'open') continue;
      fillRung(engine, win, order, upTokenId, downTokenId);
    }
  }
}

// Fills a rung as a resting maker fill at its limit price, then
// cancels the opposite side's same-price rung.
function fillRung(engine, win, order, upTokenId, downTokenId) {
  const side = order.side;
  const opposite = side === 'UP' ? 'DOWN' : 'UP';
  const entry = fireEntry(win, side, order.shares, order.price, upTokenId, downTokenId,
    `ladder fill — ${side} crossed $${order.price.toFixed(2)} (resting limit, ${order.shares}sh = $${(order.shares * order.price).toFixed(2)} cost, maker fill)`);
  order.status = 'filled';
  order.filledAt = new Date().toISOString();
  order.entryRef = entry;
  log(`[${win.engine}] LADDER FILL ${side} @ $${order.price.toFixed(2)} — ${order.shares}sh (cost $${(order.shares * order.price).toFixed(2)}) — riding to resolution`);

  const cancelTarget = (win.orders || []).find((o) => o.side === opposite && o.price === order.price && o.status === 'open');
  if (cancelTarget) {
    cancelTarget.status = 'cancelled';
    cancelTarget.cancelledAt = new Date().toISOString();
    log(`[${win.engine}] LADDER CANCEL ${opposite} @ $${order.price.toFixed(2)} (${side} $${order.price.toFixed(2)} filled — cross-cancel rule)`);
  }
}

// One full pass over a single engine: hand off closed windows, resolve
// pendings, find the live market, run the engine's strategy.
// One full pass over a single engine: hand off closed windows, resolve
// pendings, find the live market, run the engine's strategy.
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
          laddersPlaced: false,
          orders: [],
          finalUpPrice: null,
          finalDownPrice: null,
        };

        log(`${tag} Window ${windowStart} opened — DUAL LADDER: rungs $${(config.LADDER_RUNGS || []).join(', $')} × ${config.RUNG_SHARES}sh × UP+DOWN | cross-cancel same-price rungs | maker fills | live until window close | peak $${engine.peakBankroll.toFixed(2)}`);
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
        const elapsed = nowSec - win.windowStart;

        ladderTick(engine, win, engineCfg, tag, upPrice, downPrice, upTokenId, downTokenId);

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

// Replays an engine's resolved windows and computes, per skip filter
// N (config.SKIP_FILTERS), the P&L the bot WOULD have made if it had
// skipped the next N windows after N consecutive FULL-ROUND wins
// (all rungs filled + won). Purely observational — trading logic is
// untouched. Skipped windows contribute nothing; no-trade windows are
// ignored; any window that isn't a full-round win breaks the streak.
function computeSkipFilters(engine) {
  const hist = (engine && Array.isArray(engine.windowHistory)) ? engine.windowHistory : [];
  const filters = (config.SKIP_FILTERS || [1, 2, 3, 4]).map((n) => {
    let streak = 0, skipLeft = 0, pnl = 0, traded = 0, skipped = 0, fullWins = 0;
    for (const w of hist) {
      if (!w.traded) continue;
      if (skipLeft > 0) {
        skipLeft -= 1;
        skipped += 1;
        continue;
      }
      traded += 1;
      pnl += w.pnl || 0;
      if (w.fullRoundWon) {
        fullWins += 1;
        streak += 1;
        if (streak >= n) {
          skipLeft = n;
          streak = 0;
        }
      } else {
        streak = 0;
      }
    }
    return {
      label: n + 'w' + n + 's',
      n,
      traded,
      skipped,
      fullWins,
      pnl: round2(pnl),
    };
  });
  const actual = { label: 'actual', n: 0, traded: 0, skipped: 0, fullWins: 0, pnl: 0 };
  for (const w of hist) {
    if (!w.traded) continue;
    actual.traded += 1;
    actual.pnl += w.pnl || 0;
    if (w.fullRoundWon) actual.fullWins += 1;
  }
  actual.pnl = round2(actual.pnl);
  return { actual, filters };
}

function startBotLoop() {
  for (const [key, cfg] of Object.entries(config.ENGINES)) {
    const rungs = (config.LADDER_RUNGS || []).map((p) => '$' + p.toFixed(2)).join(' / ');
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}-min windows, ${cfg.STRATEGY}). Bankroll: $${cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL} | DUAL LADDER: ${rungs} × ${config.RUNG_SHARES}sh × UP+DOWN | cross-cancel same-price rungs | maker fills (20% rebate) | no cutoff — rungs live until window close`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized, computeSkipFilters };
