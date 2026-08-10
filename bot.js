// ============================================================
// bot.js — dual-engine time-scheduled cheap/expensive buys, v19.
// Runs TWO independent engines at the same time:
//
//   5m engine  (300s windows):
//     CHEAP (side with the LOWER midpoint), CHEAP_ORDER_SHARES each:
//       t = 30s  -> buy CHEAP
//       t = 60s  -> buy CHEAP
//       t = 90s  -> buy CHEAP
//     EXPENSIVE (side with the HIGHER midpoint), EXPENSIVE_ORDER_SHARES
//     each — FLIP-TIMED:
//       - Once all 3 cheap buys are done, if the side that was cheap
//         becomes the expensive side (a role flip), the expensive
//         clock starts at that flip moment: buys at flip,
//         flip + 30s, flip + 60s.
//       - No flip? Fixed fallback: t = 150s / 180s / 210s.
//
//   15m engine (900s windows):
//     CHEAP: t = 90s / 180s / 270s
//     EXPENSIVE (same flip timing): flip / flip + 90s / flip + 180s,
//     fixed fallback t = 570s / 660s / 750s.
//
// Each engine has its OWN bankroll, current window, pending
// resolutions, and history — money is never shared between them.
//
// Cheap/expensive is re-evaluated FRESH at each scheduled tick
// from the live midpoints — sides may flip mid-window and each
// order simply follows whichever side is cheap/expensive right
// then. Cheap buys are exactly CHEAP_ORDER_SHARES, expensive buys
// exactly EXPENSIVE_ORDER_SHARES, regardless of cost — no ladder,
// no pattern, no hedge.
//
// EXPENSIVE PRICE GATE: an expensive-side buy only fires while the
// expensive side's midpoint is BELOW EXPENSIVE_BUY_MAX_PRICE (0.90).
// The bot keeps checking every tick through the buy's validity
// window; if the price never drops below 0.90 by the end, the buy
// is skipped for good (never chased at a bad price).
//
// FEES & REBATES (docs.polymarket.com/trading/fees + maker-rebates):
//   Crypto: taker fee = shares x 0.07 x price x (1 - price).
//   Makers never pay fees; crypto maker rebate = 20% of the
//   fee-equivalent, only for resting (maker) fills.
//   config.ENTRY_IS_MAKER=false -> taker fills: fee charged,
//   rebate 0. true -> maker fills: fee 0, 20% rebate credited.
//
// Filled entries ride naked to real resolution (win = $1/share,
// lose = $0, no take-profit exit). Resolution: whichever side's
// price is at/above RESOLUTION_WIN_THRESHOLD in the LAST tick
// sampled before close is declared the winner immediately;
// otherwise fall back to polling the real market price until it
// converges. All filled entries for the window settle together.
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
// Cheap = lower midpoint, Expensive = higher midpoint.
function cheapSide(upPrice, downPrice) { return upPrice <= downPrice ? 'UP' : 'DOWN'; }
function expensiveSide(upPrice, downPrice) { return upPrice >= downPrice ? 'UP' : 'DOWN'; }

// Fixed expensive schedule: one buy at each configured second after
// window open (used when no flip is detected).
function fixedExpensiveSchedule(engineCfg) {
  return engineCfg.EXPENSIVE_BUY_AT_SECS.map((s) => ({ key: 'exp-' + s, sec: s }));
}

// Flip-timed expensive schedule: 3 buys at anchor, anchor+interval,
// anchor+2*interval — the interval counted from the FIRST expensive
// position (the flip moment).
function flipExpensiveSchedule(anchorSec, engineCfg) {
  const interval = engineCfg.EXPENSIVE_BUY_INTERVAL_SECS || 0;
  return engineCfg.EXPENSIVE_BUY_AT_SECS.map((_, i) => ({
    key: 'exp-flip-' + (i + 1),
    sec: anchorSec + i * interval,
  }));
}

// Decides which expensive schedule is active for this tick and locks it
// in place the first time a decision is possible:
//   - Before the first FIXED expensive second, if the side that was
//     cheap when the cheap phase ended becomes the expensive side (a
//     role flip), lock the FLIP schedule: buys at flip, flip+interval,
//     flip+2*interval.
//   - Otherwise, once the first fixed expensive second is reached (or
//     a fixed buy has already resolved), lock the FIXED schedule.
// Returns the active schedule's {key, sec} list — empty while the
// decision is still open. Mutates win.expLocked / win.expSched /
// win.flipAtSec.
function activeExpensiveSchedule(win, engineCfg, elapsed, upPrice, downPrice) {
  const firstFixed = engineCfg.EXPENSIVE_BUY_AT_SECS[0];

  if (win.expLocked) {
    return win.expSched === 'flip'
      ? flipExpensiveSchedule(win.flipAtSec, engineCfg)
      : fixedExpensiveSchedule(engineCfg);
  }

  const anyExpResolved =
    win.fired.some((k) => k.startsWith('exp-')) ||
    win.skipped.some((k) => k.startsWith('exp-'));

  if (!win.cheapPhaseDone || win.flipRefSide == null) {
    if (elapsed >= firstFixed || anyExpResolved) {
      win.expLocked = true;
      win.expSched = 'fixed';
      return fixedExpensiveSchedule(engineCfg);
    }
    return [];
  }

  // Cheap phase is over — look for the flip first, then the fixed lock.
  if (cheapSide(upPrice, downPrice) !== win.flipRefSide) {
    win.expLocked = true;
    win.expSched = 'flip';
    win.flipAtSec = elapsed;
    return flipExpensiveSchedule(elapsed, engineCfg);
  }
  if (elapsed >= firstFixed || anyExpResolved) {
    win.expLocked = true;
    win.expSched = 'fixed';
    return fixedExpensiveSchedule(engineCfg);
  }
  return [];
}

// Builds an ALREADY-FILLED entry at the moment a scheduled buy fires.
// Entries fill at the current midpoint; size is always exactly
// CHEAP_ORDER_SHARES / EXPENSIVE_ORDER_SHARES shares.
// Fee/rebate follow config.ENTRY_IS_MAKER
// (see the header comment — taker default, maker opt-in).
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
    status: 'filled', // filled -> resolved_win | resolved_loss
    resolvedWon: null,
    cost: null,
    payout: null,
    pnl: null,
    settledAt: null,
  };
}

// Records a scheduled taker/maker buy on win.entries.
function fireEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const entry = makeEntry(side, shares, fillPrice, upTokenId, downTokenId, reason);
  win.entries.push(entry);
  log(`[${win.engine || '?'}] ENTRY: ${side} ${shares}sh @ $${fillPrice.toFixed(2)} | fee $${entry.fillFee.toFixed(4)} | rebate $${entry.fillRebate.toFixed(4)} — ${reason}`);
}

// Checks whether the window's LAST observed tick (closest snapshot to
// windowEnd — see win.finalUpPrice/finalDownPrice, updated every tick
// in tick() below) already shows a side at/above the win threshold.
// If so we can declare that side the winner immediately instead of
// waiting for the real market to fully settle.
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
// still ambiguous). Settles ALL filled entries of the window together
// (win = $1/share, lose = $0; rebate credited to payout when present).
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
  let cost = 0, payout = 0, fees = 0, rebates = 0;
  const traded = entries.length > 0;

  for (const pos of entries) {
    const f = pos.fillFee || 0;
    const r = pos.fillRebate || 0;
    cost += pos.shares * pos.fillPrice + f;
    payout += (pos.side === wonSide ? pos.shares * 1 : 0) + r;
    fees += f;
    rebates += r;
    pos.resolvedWon = pos.side === wonSide;
    pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
    pos.cost = Math.round((pos.shares * pos.fillPrice + f) * 100000) / 100000;
    pos.payout = Math.round((pos.side === wonSide ? pos.shares : 0) * 100000) / 100000 + r;
    pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
    pos.settledAt = new Date().toISOString();
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  engine.bankroll = Math.round((engine.bankroll + pnl) * 100) / 100;
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
    resolvedAt: new Date().toISOString(),
  });

  log(
    `[${win.engine}] WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | ${entries.length} entries (${entries.map((e) => e.side).join(', ') || 'none'}) | payout $${payout.toFixed(2)} | cost $${cost.toFixed(2)} | fees $${fees.toFixed(5)} | rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | bankroll $${engine.bankroll}`
  );
  return true;
}

// Computes live unrealized P&L for one engine's open window using the
// latest midpoint snapshot (engine.lastCheck). Used by the dashboard's
// /api/state so positions are marked to market in real time.
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
    });
  }
  out.costBasis = round2(out.costBasis);
  out.currentValue = round2(out.currentValue);
  out.unrealizedPnl = round2(out.unrealizedPnl);
  out.fees = round2(out.fees);
  out.rebates = round2(out.rebates);
  return out;
}

// One full pass over a single engine: hand off closed windows, resolve
// pendings, find the live market, place scheduled buys, snapshot prices.
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

  // 3) Market snapshot, new-window creation, and scheduled entries.
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
          windowStart,
          windowEnd,
          upTokenId,
          downTokenId,
          signal: `TIME_SCHEDULED_CHEAP_EXPENSIVE_${engineKey}`,
          entries: [],
          fired: [],    // schedule keys already executed: cheap-30/..., exp-150/..., exp-flip-1...
          skipped: [],  // schedule keys missed (expensive price gate / validity expired)
          cheapPhaseDone: false, // true once all 3 cheap keys fired/skipped
          cheapPhaseDoneAt: null, // window-relative second the cheap phase ended
          flipRefSide: null,      // cheap side at cheap-phase end — flip watch reference
          flipAtSec: null,        // window-relative second the flip was detected (if any)
          expLocked: false,       // expensive schedule decided and locked
          expSched: null,         // 'flip' | 'fixed'
          finalUpPrice: null,
          finalDownPrice: null,
        };

        log(`${tag} Window ${windowStart}: CHEAP ${engineCfg.CHEAP_ORDER_SHARES}sh @ ${engineCfg.CHEAP_BUY_AT_SECS.join('/')}s | EXPENSIVE ${engineCfg.EXPENSIVE_ORDER_SHARES}sh @ flip/+${engineCfg.EXPENSIVE_BUY_INTERVAL_SECS}s/+${2 * engineCfg.EXPENSIVE_BUY_INTERVAL_SECS}s (fallback ${engineCfg.EXPENSIVE_BUY_AT_SECS.join('/')}s, < $${engineCfg.EXPENSIVE_BUY_MAX_PRICE}) | ${config.ENTRY_IS_MAKER ? 'MAKER' : 'TAKER'} fills`);
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
        const validity = engineCfg.BUY_FIRE_VALIDITY_SECS;

        // CHEAP — one buy at each scheduled second. Each has a validity
        // window (sec .. sec+validity) so a mid-window restart doesn't
        // dump all missed cheap buys at once. Side re-evaluated fresh.
        engineCfg.CHEAP_BUY_AT_SECS.forEach((sec, i) => {
          const key = 'cheap-' + sec;
          if (win.fired.includes(key) || win.skipped.includes(key)) return;
          if (elapsed >= sec && elapsed < sec + validity) {
            const side = cheapSide(upPrice, downPrice);
            win.fired.push(key);
            fireEntry(win, side, engineCfg.CHEAP_ORDER_SHARES, priceOf(side, upPrice, downPrice), upTokenId, downTokenId,
              `cheap buy #${i + 1} — t=${sec}s (${side} is cheap at $${priceOf(side, upPrice, downPrice).toFixed(2)})`);
          } else if (elapsed >= sec + validity) {
            win.skipped.push(key);
            log(`${tag} SKIP cheap buy t=${sec}s — validity window passed`);
          }
        });

        // Cheap phase complete = every cheap key has fired or been
        // skipped. Once done, snapshot the current cheap side — that
        // becomes the reference for flip detection: if IT becomes the
        // expensive side later, the expensive clock starts there.
        if (!win.cheapPhaseDone) {
          const cheapKeys = engineCfg.CHEAP_BUY_AT_SECS.map((s) => 'cheap-' + s);
          if (cheapKeys.every((k) => win.fired.includes(k) || win.skipped.includes(k))) {
            win.cheapPhaseDone = true;
            win.cheapPhaseDoneAt = elapsed;
            win.flipRefSide = cheapSide(upPrice, downPrice);
            log(`${tag} Cheap phase complete at t=${elapsed}s — watching ${win.flipRefSide} for a flip to expensive`);
          }
        }

        // EXPENSIVE — FLIP-TIMED schedule, gated: only fires while the
        // expensive side's price is below EXPENSIVE_BUY_MAX_PRICE.
        // activeExpensiveSchedule() picks the schedule:
        //   - flip detected (cheap side became expensive after the
        //     cheap phase) -> buys at flip, flip+interval, flip+2*interval
        //   - otherwise -> fixed times (5m: 150/180/210, 15m: 570/660/750)
        // Each buy keeps checking every tick until its validity window
        // closes; if the price never drops below, the buy is skipped.
        const prevExpSched = win.expSched;
        const expSched = activeExpensiveSchedule(win, engineCfg, elapsed, upPrice, downPrice);
        if (win.expSched === 'flip' && prevExpSched !== 'flip') {
          log(`${tag} FLIP DETECTED at t=${elapsed}s — ${win.flipRefSide} became expensive; expensive buys at t=${elapsed}s/+${engineCfg.EXPENSIVE_BUY_INTERVAL_SECS}s/+${2 * engineCfg.EXPENSIVE_BUY_INTERVAL_SECS}s`);
        }
        for (const { key, sec } of expSched) {
          if (win.fired.includes(key) || win.skipped.includes(key)) continue;
          if (elapsed >= sec && elapsed < sec + validity) {
            const side = expensiveSide(upPrice, downPrice);
            const px = priceOf(side, upPrice, downPrice);
            if (px < engineCfg.EXPENSIVE_BUY_MAX_PRICE) {
              win.fired.push(key);
              fireEntry(win, side, engineCfg.EXPENSIVE_ORDER_SHARES, px, upTokenId, downTokenId,
                `expensive buy ${key} @ t=${sec}s (${side} is expensive at $${px.toFixed(2)})`);
            } else {
              // Price still too rich — keep waiting, but only log the
              // hold every 5s so the log stays readable.
              const holdKey = engineKey + ':' + key;
              const nowMs = Date.now();
              if (!lastHoldLogAt[holdKey] || nowMs - lastHoldLogAt[holdKey] >= 5000) {
                lastHoldLogAt[holdKey] = nowMs;
                log(`${tag} HOLD expensive buy ${key} t=${sec}s — ${side} at $${px.toFixed(2)} ≥ $${engineCfg.EXPENSIVE_BUY_MAX_PRICE}, waiting for a better price`);
              }
            }
          } else if (elapsed >= sec + validity) {
            win.skipped.push(key);
            log(`${tag} SKIP expensive buy ${key} t=${sec}s — never below $${engineCfg.EXPENSIVE_BUY_MAX_PRICE} in time`);
          }
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
// Last time we logged a HOLD (expensive price gate) for a given
// engine+buy key — used to avoid spamming the log every poll.
const lastHoldLogAt = {};

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
    log(`Bot started — ${key} engine (${cfg.WINDOW_MINUTES}-min windows). Bankroll: $${cfg.CAPITAL != null ? cfg.CAPITAL : config.STARTING_BANKROLL} | CHEAP ${cfg.CHEAP_ORDER_SHARES}sh @ ${cfg.CHEAP_BUY_AT_SECS.join('/')}s | EXPENSIVE ${cfg.EXPENSIVE_ORDER_SHARES}sh @ ${cfg.EXPENSIVE_BUY_AT_SECS.join('/')}s (< $${cfg.EXPENSIVE_BUY_MAX_PRICE}) | ${config.ENTRY_IS_MAKER ? 'MAKER fills (20% rebate)' : 'TAKER fills (0.07 fee)'} | rides to resolution, no TP`);
  }
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized, __test: { activeExpensiveSchedule, cheapSide, expensiveSide } };
