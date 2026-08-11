// ============================================================
// bot.js — v24. ONE unified engine shape (5m and 15m), each with its
// own bankroll, own bucket, current window, pending resolutions, and
// history. Both engines run the SAME DIP_RECOVERY strategy — the 15m
// is a proportional mirror of the 5m (see config.js):
//
//   5m / 15m — DIP_RECOVERY:
//     MONITOR the first MONITOR_SECS (5m 120s / 15m 420s), record the
//     last moment each side is below DIP_LEVEL (0.50); TARGET = latest
//     dipper; no dip -> no trade. After the monitor phase, when the
//     target returns to 0.50, buy BUY_AMOUNT (5m $100 / 15m $300)
//     PLUS the mini bucket installment. NO STOP LOSS — every position
//     rides to resolution, win or lose.
//
//   BUCKET FILTER (main + mini):
//     - Every loss adds its FULL dollar loss to the MAIN bucket, then
//       re-splits: miniBucket = bucket / BUCKET_DIVISOR.
//     - The next window bets base + miniBucket.
//     - ONE win of a mini-bucket bet clears the WHOLE bucket (main and
//       mini go to 0). A loss re-splits by BUCKET_DIVISOR again.
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
//   config.ENTRY_IS_MAKER=false -> taker fills: fee charged,
//   rebate 0. true -> maker fills: fee 0, 20% rebate credited.
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

// Builds an ALREADY-FILLED entry at the moment a buy fires. Entries
// fill at the current midpoint; size is fixed (shares) per order.
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
      } else {
        // Bucket filter: a resolution loss (no SL) adds its full loss
        // to the main bucket and re-splits the mini installment.
        engine.bucket = Math.round((engine.bucket + Math.abs(pos.pnl)) * 100) / 100;
        engine.miniBucket = Math.round((engine.bucket / config.BUCKET_DIVISOR) * 100) / 100;
        log(`[${win.engine}] BUCKET + $${Math.abs(pos.pnl).toFixed(2)} (${pos.side} lost at resolution) -> main $${engine.bucket.toFixed(2)} | mini $${engine.miniBucket.toFixed(2)}`);
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

  // Bucket filter: ONE win of a mini-bucket bet clears the WHOLE
  // bucket (main + mini go to 0).
  if (resolvedWin && win.bucketWager != null && win.bucketWager > 0) {
    engine.bucket = 0;
    engine.miniBucket = 0;
    log(`[${win.engine}] BUCKET CLEARED (won $${win.bucketWager.toFixed(2)} mini bet) — main $0.00 | mini $0.00`);
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
    bucketWager: win.bucketWager,
    bucketAfter: engine.bucket,
    miniBucketAfter: engine.miniBucket,
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
  if (!win || !Array.isArray(win.entries) || win.entries.length === 0) return out;

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
  out.costBasis = round2(out.costBasis);
  out.currentValue = round2(out.currentValue);
  out.unrealizedPnl = round2(out.unrealizedPnl);
  out.fees = round2(out.fees);
  out.rebates = round2(out.rebates);
  return out;
}

// ---- engines (5m & 15m): DIP_RECOVERY (pure dip signal, no SL) ----
function dipRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId) {
  // MONITOR phase: record the last moment each side is below DIP_LEVEL
  // (0.30 — the latest dip must come from below 0.30 to qualify).
  if (!win.monitoringDone) {
    if (elapsed <= engineCfg.MONITOR_SECS) {
      if (upPrice < engineCfg.DIP_LEVEL) win.lastDipSec.UP = elapsed;
      if (downPrice < engineCfg.DIP_LEVEL) win.lastDipSec.DOWN = elapsed;
    }
    if (elapsed >= engineCfg.MONITOR_SECS) {
      win.monitoringDone = true;
      const upDip = win.lastDipSec.UP;
      const downDip = win.lastDipSec.DOWN;
      if (upDip == null && downDip == null) {
        win.targetSide = null;
        log(`${tag} Monitor complete at t=${elapsed}s — neither side dipped below $${engineCfg.DIP_LEVEL}; NO TRADE this window`);
      } else if (downDip != null && (upDip == null || downDip > upDip)) {
        win.targetSide = 'DOWN';
        log(`${tag} Monitor complete at t=${elapsed}s — target DOWN (last dip t=${downDip}s below $${engineCfg.DIP_LEVEL}); waiting for return to $${engineCfg.RETURN_LEVEL}`);
      } else if (upDip != null && (downDip == null || upDip > downDip)) {
        win.targetSide = 'UP';
        log(`${tag} Monitor complete at t=${elapsed}s — target UP (last dip t=${upDip}s below $${engineCfg.DIP_LEVEL}); waiting for return to $${engineCfg.RETURN_LEVEL}`);
      } else {
        win.targetSide = upPrice <= downPrice ? 'UP' : 'DOWN';
        log(`${tag} Monitor complete at t=${elapsed}s — dip tie, target ${win.targetSide} (cheaper now); waiting for return to $${engineCfg.RETURN_LEVEL}`);
      }
    }
  }

  // ENTRY: after the monitor phase, buy BUY_AMOUNT worth PLUS the
  // mini bucket installment once the target side comes back to
  // RETURN_LEVEL:
  //   baseShares  = floor(BUY_AMOUNT / px)
  //   extraShares = floor(engine.miniBucket / px)
  // NO STOP LOSS — the position rides to resolution.
  if (win.monitoringDone && !win.entryFired && !win.entrySkipped) {
    if (win.targetSide == null) {
      win.entrySkipped = true;
      log(`${tag} No target side — no entry for window ${win.windowStart}`);
    } else {
      const px = priceOf(win.targetSide, upPrice, downPrice);
      if (px >= engineCfg.RETURN_LEVEL) {
        win.bucketWager = Math.max(0, engine.miniBucket || 0);
        const baseShares = Math.floor(engineCfg.BUY_AMOUNT / px);
        const extraShares = win.bucketWager > 0 ? Math.floor(win.bucketWager / px) : 0;
        const shares = baseShares + extraShares;
        if (shares > 0) {
          win.entryFired = true;
          win.bucketThirdShares = extraShares;
          fireEntry(win, win.targetSide, shares, px, upTokenId, downTokenId,
            `dip-recovery buy — ${win.targetSide} back to $${px.toFixed(2)} after t=${engineCfg.MONITOR_SECS}s; base $${engineCfg.BUY_AMOUNT} (${baseShares}sh) + mini $${win.bucketWager.toFixed(2)} (${extraShares}sh) = ${shares}sh, rides to resolution`);
        } else {
          win.entrySkipped = true;
          log(`${tag} Entry skipped — price $${px.toFixed(2)} too high for $${engineCfg.BUY_AMOUNT}`);
        }
      }
    }
  }
}

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
          monitoringDone: false,
          lastDipSec: { UP: null, DOWN: null },
          targetSide: null,
          entrySkipped: false,
          entryFired: false,
          // Bucket filter: the mini installment wagered on this
          // window's entry (a win clears the whole bucket).
          bucketWager: null,
          bucketThirdShares: 0,
          finalUpPrice: null,
          finalDownPrice: null,
        };

        log(`${tag} Window ${windowStart}: MONITOR ${engineCfg.MONITOR_SECS}s (dip < $${engineCfg.DIP_LEVEL}) | ENTRY $${engineCfg.BUY_AMOUNT} (+ mini $${engine.miniBucket.toFixed(2)}) when target returns to $${engineCfg.RETURN_LEVEL} | no SL | main $${engine.bucket.toFixed(2)} | peak $${engine.peakBankroll.toFixed(2)} | ${config.ENTRY_IS_MAKER ? 'MAKER' : 'TAKER'} fills`);
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

        dipRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId);

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
    const summary = `MONITOR ${cfg.MONITOR_SECS}s (dip < $${cfg.DIP_LEVEL}) | ENTRY $${cfg.BUY_AMOUNT} (+ mini = main/${config.BUCKET_DIVISOR}) @ return to $${cfg.RETURN_LEVEL} | no SL`;
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}-min windows, ${cfg.STRATEGY}). Bankroll: $${cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL} | ${summary} | ${config.ENTRY_IS_MAKER ? 'MAKER fills (20% rebate)' : 'TAKER fills (0.07 fee)'}`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
