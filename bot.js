// ============================================================
// bot.js — v21. TWO independent engines (5m and 15m), each with its
// own bankroll, current window, pending resolutions, and history.
// Each engine has its OWN strategy (see config.js):
//
//   5m engine  — DIP_RECOVERY:
//     MONITOR first 120s, record the last moment each side is below
//     0.50; TARGET = latest dipper. After 120s, when the target
//     returns to 0.50, buy $100 worth. STOP LOSS 0.20.
//
//   15m engine — EXPENSIVE_RECOVERY:
//     At/after 420s buy 300 shares on the EXPENSIVE side at any
//     price. STOP LOSS 0.40. Right after entry compute the SL loss
//     L = (fill - 0.40) x 300 + fee. When SL hits, IMMEDIATELY place
//     a recovery bet on the OPPOSITE side sized to recover carry + L
//     (shares = ceil(target / ((1-p) x (1 - 0.07p)))). Recovery wins
//     -> carry cleared; recovery loses or is stopped out -> the full
//     loss rolls into the carry. When a carry is owed at the next 420s
//     signal, ALSO place a carry-recovery on the SIGNAL side sized to
//     recover the carry (signal logic runs as normal). EVERY bet (main,
//     in-window recovery, carry-recovery) carries STOP LOSS 0.40, and
//     all stopped-out/recovered losses feed the carry so the next
//     recovery amount is always correct. A main-bet win leaves the
//     carry untouched.
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
function expensiveSide(upPrice, downPrice) { return upPrice >= downPrice ? 'UP' : 'DOWN'; }
function recoveryShares(target, px) {
  // Net profit per share if px-side wins, after taker fee:
  // (1 - p) - 0.07*p*(1-p) = (1 - p) x (1 - 0.07p).
  const netPerShare = (1 - px) * (1 - config.BASE_TAKER_FEE_RATE * px);
  if (netPerShare <= 0) return 0;
  return Math.ceil(target / netPerShare);
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
// 15m recovery carry: if this window placed a recovery bet, its
// outcome updates engine.recoveryCarry (win -> 0, lose -> target +
// recovery cost).
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
    }
    cost += pos.cost;
    payout += pos.payout;
  }

  if (settleCredit !== 0) {
    engine.bankroll = Math.round((engine.bankroll + settleCredit) * 100) / 100;
  }

  // 15m recovery carry update. One recovery bet per window — either the
  // 420s carry-recovery on the signal side, or the SL-triggered recovery
  // on the opposite side. A recovery WIN clears the carried amount; if no
  // recovery wins, EVERY unrecovered loss this window (main + recovery,
  // stopped out at 0.40 or resolved) rolls into the carry so the next
  // window's carry-recovery is sized correctly. Main-bet wins never
  // reduce the carry — only a recovery win does.
  const recEntries = entries.filter((e) => e.isCarryRecovery || e.isSlRecovery);
  if (recEntries.length > 0) {
    const preCarry = win.preCarry != null ? win.preCarry : engine.recoveryCarry;
    const wonRec = recEntries.find((e) => e.status === 'resolved_win');
    if (wonRec) {
      if (wonRec.isSlRecovery) {
        // The SL-recovery's target already included the main's SL loss,
        // so a win covers carry + that loss completely.
        engine.recoveryCarry = 0;
        log(`[${win.engine}] RECOVERY WON (${wonRec.side} ${wonRec.shares}sh @ $${wonRec.fillPrice.toFixed(2)}) — carry cleared to $0.00`);
      } else {
        const mainEntry = entries.find((e) => !e.isCarryRecovery && !e.isSlRecovery);
        const freshDeficit = mainEntry && mainEntry.pnl != null && mainEntry.pnl < 0 ? Math.round(Math.abs(mainEntry.pnl) * 100) / 100 : 0;
        engine.recoveryCarry = freshDeficit;
        log(`[${win.engine}] CARRY-RECOVERY WON (${wonRec.side} ${wonRec.shares}sh @ $${wonRec.fillPrice.toFixed(2)}) — carry ${freshDeficit > 0 ? `now $${engine.recoveryCarry.toFixed(2)} (fresh main SL loss)` : 'cleared to $0.00'}`);
      }
    } else {
      const losses = entries.reduce((a, e) => a + (e.pnl != null && e.pnl < 0 ? -e.pnl : 0), 0);
      engine.recoveryCarry = Math.round((preCarry + losses) * 100) / 100;
      log(`[${win.engine}] RECOVERY ${win.recoveryStoppedOut ? 'STOPPED OUT' : 'LOST'} — carry now $${engine.recoveryCarry.toFixed(2)} (pre-carry $${preCarry.toFixed(2)} + losses $${Math.round(losses * 100) / 100})`);
    }
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  const isLoss = traded ? pnl < 0 : null;

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
    recoveryCarryAfter: engine.recoveryCarry,
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

// ---- 5m engine: DIP_RECOVERY ----
function dipRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId) {
  // MONITOR phase: record the last moment each side is below DIP_LEVEL.
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

  // ENTRY: after the monitor phase, buy $100 worth once the target
  // side comes back to RETURN_LEVEL.
  if (win.monitoringDone && !win.entryFired && !win.entrySkipped) {
    if (win.targetSide == null) {
      win.entrySkipped = true;
      log(`${tag} No target side — no entry for window ${win.windowStart}`);
    } else {
      const px = priceOf(win.targetSide, upPrice, downPrice);
      if (px >= engineCfg.RETURN_LEVEL) {
        const shares = Math.floor(engineCfg.BUY_AMOUNT / px);
        if (shares > 0) {
          win.entryFired = true;
          fireEntry(win, win.targetSide, shares, px, upTokenId, downTokenId,
            `dip-recovery buy — ${win.targetSide} back to $${px.toFixed(2)} after t=${engineCfg.MONITOR_SECS}s; $${engineCfg.BUY_AMOUNT} worth (${shares} shares)`);
        } else {
          win.entrySkipped = true;
          log(`${tag} Entry skipped — price $${px.toFixed(2)} too high for $${engineCfg.BUY_AMOUNT}`);
        }
      }
    }
  }

  // STOP LOSS 0.20.
  if (win.entryFired && !win.stoppedOut) {
    const pos = win.entries[win.entries.length - 1];
    const cur = priceOf(pos.side, upPrice, downPrice);
    if (cur <= engineCfg.STOP_LOSS_LEVEL) {
      win.stoppedOut = true;
      pos.status = 'stopped_out';
      pos.exitPrice = engineCfg.STOP_LOSS_LEVEL;
      const f = pos.fillFee || 0;
      pos.cost = Math.round((pos.shares * pos.fillPrice + f) * 100000) / 100000;
      pos.payout = Math.round((pos.shares * pos.exitPrice) * 100000) / 100000;
      pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
      pos.settledAt = new Date().toISOString();
      engine.bankroll = Math.round((engine.bankroll + pos.pnl) * 100) / 100;
      log(`${tag} STOP LOSS @ t=${elapsed}s — ${pos.side} hit $${cur.toFixed(2)} ≤ $${engineCfg.STOP_LOSS_LEVEL}; exited ${pos.shares}sh @ $${pos.exitPrice.toFixed(2)} | pnl $${pos.pnl.toFixed(2)} | bankroll $${engine.bankroll}`);
    }
  }
}

// ---- 15m engine: EXPENSIVE_RECOVERY ----
function expensiveRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId) {
  // 1) ENTRY: after ENTRY_AFTER_SECS, buy ENTRY_SHARES on the expensive
  //    side at ANY price. Compute the potential SL loss right away.
  if (!win.entryFired) {
    if (elapsed >= engineCfg.ENTRY_AFTER_SECS) {
      const side = expensiveSide(upPrice, downPrice);
      const px = priceOf(side, upPrice, downPrice);
      win.entryFired = true;
      fireEntry(win, side, engineCfg.ENTRY_SHARES, px, upTokenId, downTokenId,
        `expensive entry after t=${engineCfg.ENTRY_AFTER_SECS}s — ${side} @ $${px.toFixed(2)} (${engineCfg.ENTRY_SHARES} shares, any price)`);
      const pos = win.entries[0];
      const f = pos.fillFee || 0;
      win.potentialSlLoss = Math.round(((pos.fillPrice - engineCfg.STOP_LOSS_LEVEL) * pos.shares + f) * 100) / 100;
      log(`${tag} Potential SL loss if hit: $${win.potentialSlLoss.toFixed(2)} (fill $${px.toFixed(2)} - SL $${engineCfg.STOP_LOSS_LEVEL}) x ${pos.shares}sh + fee $${f.toFixed(4)}`);

      // 1b) CARRY-RECOVERY: if a deficit is still owed from previous
      //     windows, place the recovery NOW on the side that got the
      //     420s signal (the expensive side). It rides to resolution;
      //     a win clears the carry, a loss rolls carry + cost into the
      //     next window. The signal logic itself runs exactly as normal.
      if (engine.recoveryCarry > 0 && !win.carryRecoveryPlaced) {
        const carry = engine.recoveryCarry;
        const shares = recoveryShares(carry, px);
        if (shares > 0) {
          win.carryRecoveryPlaced = true;
          win.preCarry = carry;
          win.carryRecoveryTarget = carry;
          win.carryRecoverySide = side;
          const carryEntry = makeEntry(side, shares, px, upTokenId, downTokenId,
            `carry-recovery — recover $${carry.toFixed(2)} via ${side} @ $${px.toFixed(2)} (signal side at t=${engineCfg.ENTRY_AFTER_SECS}s)`);
          carryEntry.isCarryRecovery = true;
          win.entries.push(carryEntry);
          log(`${tag} CARRY-RECOVERY placed: target $${carry.toFixed(2)} -> ${shares}sh ${side} @ $${px.toFixed(2)} (signal side)`);
        } else {
          log(`${tag} Carry-recovery skipped — $${carry.toFixed(2)} needs more than 0 shares at $${px.toFixed(2)}`);
        }
      }
    }
  }

  // 2) STOP LOSS 0.40 -> exit, then IMMEDIATELY place the recovery bet
  //    on the OPPOSITE side, sized to recover carry + SL loss.
  //    EVERY bet has the same 0.40 stop loss, so the main entry stops
  //    out whether or not a carry-recovery is riding. Only the
  //    SL-triggered recovery on the opposite side is skipped when a
  //    carry-recovery already exists — one recovery bet per window —
  //    and the fresh SL loss folds into the carry at resolution.
  if (win.entryFired && !win.stoppedOut) {
    const pos = win.entries[0];
    const cur = priceOf(pos.side, upPrice, downPrice);
    if (cur <= engineCfg.STOP_LOSS_LEVEL) {
      win.stoppedOut = true;
      pos.status = 'stopped_out';
      pos.exitPrice = engineCfg.STOP_LOSS_LEVEL;
      const f = pos.fillFee || 0;
      pos.cost = Math.round((pos.shares * pos.fillPrice + f) * 100000) / 100000;
      pos.payout = Math.round((pos.shares * pos.exitPrice) * 100000) / 100000;
      pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
      pos.settledAt = new Date().toISOString();
      engine.bankroll = Math.round((engine.bankroll + pos.pnl) * 100) / 100;
      log(`${tag} STOP LOSS @ t=${elapsed}s — ${pos.side} hit $${cur.toFixed(2)} ≤ $${engineCfg.STOP_LOSS_LEVEL}; exited ${pos.shares}sh @ $${pos.exitPrice.toFixed(2)} | pnl $${pos.pnl.toFixed(2)} | bankroll $${engine.bankroll}`);

      if (!win.carryRecoveryPlaced) {
        // Recovery bet on the opposite side.
        const recSide = pos.side === 'UP' ? 'DOWN' : 'UP';
        const recPx = priceOf(recSide, upPrice, downPrice);
        const target = Math.round((engine.recoveryCarry + win.potentialSlLoss) * 100) / 100;
        const shares = recoveryShares(target, recPx);
        if (shares > 0) {
          win.recoveryPlaced = true;
          win.preCarry = engine.recoveryCarry;
          win.recoveryTarget = target;
          win.recoverySide = recSide;
          const recEntry = makeEntry(recSide, shares, recPx, upTokenId, downTokenId,
            `recovery bet — recover $${target.toFixed(2)} (SL loss $${win.potentialSlLoss.toFixed(2)} + carry $${engine.recoveryCarry.toFixed(2)}) via ${recSide} @ $${recPx.toFixed(2)} (SL $${engineCfg.STOP_LOSS_LEVEL})`);
          recEntry.isSlRecovery = true;
          win.entries.push(recEntry);
          log(`${tag} Recovery placed: target $${target.toFixed(2)} -> ${shares}sh ${recSide} @ $${recPx.toFixed(2)} (net/share $${((1 - recPx) * (1 - config.BASE_TAKER_FEE_RATE * recPx)).toFixed(4)})`);
        } else {
          log(`${tag} Recovery skipped — $${target.toFixed(2)} needs more than 0 shares at $${recPx.toFixed(2)}`);
        }
      } else {
        log(`${tag} SL-recovery skipped — carry-recovery already riding; main SL loss $${pos.pnl.toFixed(2)} folds into carry at resolution`);
      }
    }
  }

  // 3) RECOVERY STOP LOSS 0.40 — EVERY bet carries the same stop loss,
  //    including the in-window recovery and the next-window carry
  //    recovery. A stopped-out recovery realizes its loss on the
  //    bankroll immediately; the full loss rolls into the carry at
  //    resolution so the next recovery is sized correctly.
  if (win.recoveryPlaced || win.carryRecoveryPlaced) {
    const recEntry = win.entries.find((e) => e.isCarryRecovery || e.isSlRecovery);
    if (recEntry && recEntry.status === 'filled') {
      const cur = priceOf(recEntry.side, upPrice, downPrice);
      if (cur <= engineCfg.STOP_LOSS_LEVEL) {
        recEntry.status = 'stopped_out';
        recEntry.exitPrice = engineCfg.STOP_LOSS_LEVEL;
        const f = recEntry.fillFee || 0;
        recEntry.cost = Math.round((recEntry.shares * recEntry.fillPrice + f) * 100000) / 100000;
        recEntry.payout = Math.round((recEntry.shares * recEntry.exitPrice) * 100000) / 100000;
        recEntry.pnl = Math.round((recEntry.payout - recEntry.cost) * 100000) / 100000;
        recEntry.settledAt = new Date().toISOString();
        engine.bankroll = Math.round((engine.bankroll + recEntry.pnl) * 100) / 100;
        win.recoveryStoppedOut = true;
        log(`${tag} RECOVERY STOP LOSS @ t=${elapsed}s — ${recEntry.side} hit $${cur.toFixed(2)} ≤ $${engineCfg.STOP_LOSS_LEVEL}; exited ${recEntry.shares}sh @ $${recEntry.exitPrice.toFixed(2)} | pnl $${recEntry.pnl.toFixed(2)} | bankroll $${engine.bankroll} | loss rolls into carry at resolution`);
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
          // DIP_RECOVERY fields
          monitoringDone: false,
          lastDipSec: { UP: null, DOWN: null },
          targetSide: null,
          entrySkipped: false,
          // EXPENSIVE_RECOVERY fields
          potentialSlLoss: null,
          recoveryPlaced: false,
          recoveryTarget: null,
          recoverySide: null,
          recoveryStoppedOut: false,
          carryRecoveryPlaced: false,
          preCarry: null,
          carryRecoveryTarget: null,
          carryRecoverySide: null,
          // shared
          entryFired: false,
          stoppedOut: false,
          finalUpPrice: null,
          finalDownPrice: null,
        };

        log(`${tag} Window ${windowStart}: ${engineCfg.STRATEGY === 'EXPENSIVE_RECOVERY'
          ? `ENTRY ${engineCfg.ENTRY_SHARES}sh expensive after t=${engineCfg.ENTRY_AFTER_SECS}s (any price) | SL $${engineCfg.STOP_LOSS_LEVEL} on all bets | recovery @420s on signal side`
          : `MONITOR ${engineCfg.MONITOR_SECS}s (dip < $${engineCfg.DIP_LEVEL}) | ENTRY $${engineCfg.BUY_AMOUNT} when target returns to $${engineCfg.RETURN_LEVEL} | SL $${engineCfg.STOP_LOSS_LEVEL}`} | ${config.ENTRY_IS_MAKER ? 'MAKER' : 'TAKER'} fills`);
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

        if (engineCfg.STRATEGY === 'EXPENSIVE_RECOVERY') {
          expensiveRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId);
        } else {
          dipRecoveryTick(engine, win, engineCfg, tag, elapsed, upPrice, downPrice, upTokenId, downTokenId);
        }

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
    const summary = cfg.STRATEGY === 'EXPENSIVE_RECOVERY'
      ? `ENTRY ${cfg.ENTRY_SHARES}sh expensive after t=${cfg.ENTRY_AFTER_SECS}s (any price) | SL $${cfg.STOP_LOSS_LEVEL} on all bets | recovery @420s on signal side`
      : `MONITOR ${cfg.MONITOR_SECS}s (dip < $${cfg.DIP_LEVEL}) | ENTRY $${cfg.BUY_AMOUNT} @ return to $${cfg.RETURN_LEVEL} | SL $${cfg.STOP_LOSS_LEVEL}`;
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}-min windows, ${cfg.STRATEGY}). Bankroll: $${cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL} | ${summary} | ${config.ENTRY_IS_MAKER ? 'MAKER fills (20% rebate)' : 'TAKER fills (0.07 fee)'}`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
