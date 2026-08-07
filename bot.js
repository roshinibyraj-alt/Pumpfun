// ============================================================
// bot.js — time-scheduled cheap/expensive buys, v15. Per 5-minute
// window (300 seconds):
//
//   CHEAP side (the side with the LOWER midpoint), one 50-share
//   buy per 30-second block:
//     t = 0-30s    -> buy CHEAP, 50 shares
//     t = 30-60s   -> buy CHEAP, 50 shares
//     t = 60-90s   -> buy CHEAP, 50 shares
//
//   EXPENSIVE side (the side with the HIGHER midpoint), one
//   50-share buy at each of:
//     t = 210s     -> buy EXPENSIVE, 50 shares
//     t = 240s     -> buy EXPENSIVE, 50 shares
//     t = 270s     -> buy EXPENSIVE, 50 shares
//
// Cheap/expensive is re-evaluated FRESH at each scheduled tick
// from the live midpoints — sides may flip mid-window and each
// order simply follows whichever side is cheap/expensive right
// then. Every order is exactly config.ORDER_SHARES (50) shares
// regardless of cost — no ladder, no pattern, no hedge.
//
// Filled entries ride naked to real resolution (win = $1/share,
// lose = $0, no take-profit exit). Resolution: whichever side's
// price is at/above RESOLUTION_WIN_THRESHOLD in the LAST tick
// sampled before close is declared the winner immediately;
// otherwise fall back to polling the real market price until it
// converges. All filled entries for the window settle together.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function priceOf(side, upPrice, downPrice) {
  return side === 'UP' ? upPrice : downPrice;
}
// Cheap = lower midpoint, Expensive = higher midpoint.
function cheapSide(upPrice, downPrice) { return upPrice <= downPrice ? 'UP' : 'DOWN'; }
function expensiveSide(upPrice, downPrice) { return upPrice >= downPrice ? 'UP' : 'DOWN'; }

// Builds an ALREADY-FILLED entry at the moment a scheduled buy fires.
// Entries are immediate taker fills at the current midpoint; the
// size is always exactly config.ORDER_SHARES shares.
function makeEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const tokenId = side === 'UP' ? upTokenId : downTokenId;
  const fillFee = Math.round(shares * config.BASE_TAKER_FEE_RATE * fillPrice * (1 - fillPrice) * 100000) / 100000;
  return {
    side,
    tokenId,
    shares,
    fillPrice,
    fillFee,
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

// Records a scheduled taker buy on win.entries.
function fireEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
  const entry = makeEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason);
  win.entries.push(entry);
  log(`ENTRY (TAKER): ${side} ${shares}sh @ $${fillPrice.toFixed(2)} — ${reason}`);
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
// (win = $1/share, lose = $0). Returns true if resolved this call,
// false if still waiting on convergence.
async function resolveWindow(win, state) {
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
  let cost = 0, payout = 0, fees = 0;
  const traded = entries.length > 0;

  for (const pos of entries) {
    const f = pos.fillFee || 0;
    cost += pos.shares * pos.fillPrice + f;
    payout += (pos.side === wonSide ? pos.shares * 1 : 0);
    fees += f;
    pos.resolvedWon = pos.side === wonSide;
    pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
    pos.cost = Math.round((pos.shares * pos.fillPrice + f) * 100000) / 100000;
    pos.payout = Math.round((pos.side === wonSide ? pos.shares : 0) * 100000) / 100000;
    pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
    pos.settledAt = new Date().toISOString();
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;
  const isLoss = traded ? pnl < 0 : null;

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    signal: win.signal,
    entries,
    entryCount: entries.length,
    sides: entries.map((e) => e.side),
    wonSide,
    traded,
    totalFees: Math.round(fees * 100000) / 100000,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    isLoss,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | ${entries.length} entries (${entries.map((e) => e.side).join(', ') || 'none'}) | payout $${payout.toFixed(2)} | cost $${cost.toFixed(2)} | fees $${fees.toFixed(5)} | pnl $${pnl.toFixed(2)} | bankroll $${state.bankroll}`
  );
  return true;
}

let tickRunning = false;
async function tick() {
  if (tickRunning) return; // never overlap async ticks — a slow network call
  tickRunning = true;
  try {
    const state = loadState();
    const nowSec = Math.floor(Date.now() / 1000);

    // 1) Hand off the current window for resolution the moment its time
    //    is up — BEFORE we look at creating the next window.
    try {
      if (state.currentWindow && nowSec >= state.currentWindow.windowEnd) {
        state.pendingResolutions.push(state.currentWindow);
        log(`Window ${state.currentWindow.windowStart} closed -> pending resolution`);
        state.currentWindow = null;
      }
    } catch (e) {
      log('ERROR handing off closed window:', e.message);
      state.lastError = e.message;
    }

    // 2) Resolution pass — isolated in its own try/catch so a hiccup
    //    here can't block the rest of the tick.
    try {
      const stillPending = [];
      for (const win of state.pendingResolutions) {
        const resolved = await resolveWindow(win, state);
        if (!resolved) stillPending.push(win);
      }
      state.pendingResolutions = stillPending;
      if (!state.lastError) state.lastError = null;
    } catch (e) {
      log('ERROR in resolution pass:', e.message);
      state.lastError = e.message;
    }

    // 3) Market snapshot, new-window creation, and scheduled entries.
    try {
      const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);

      if (found) {
        const { market, windowStart, windowEnd } = found;
        const { upTokenId, downTokenId } = polymarket.parseTokens(market);

        if (!state.currentWindow || state.currentWindow.windowStart !== windowStart) {
          // Safety net: if for some reason step 1 didn't already catch
          // a stale window, hand it off here too.
          if (state.currentWindow) {
            state.pendingResolutions.push(state.currentWindow);
            log(`Window ${state.currentWindow.windowStart} closed -> pending resolution (late detection)`);
          }

          state.currentWindow = {
            windowStart,
            windowEnd,
            upTokenId,
            downTokenId,
            signal: 'TIME_SCHEDULED_CHEAP_EXPENSIVE',
            entries: [],  // every 50-share order taken this window
            fired: [],    // schedule keys already executed: cheap-0/1/2, exp-210/240/270
            finalUpPrice: null,
            finalDownPrice: null,
          };

          log(`Window ${windowStart}: time-scheduled cheap/expensive — CHEAP x${config.CHEAP_BUY_BUCKETS.length} in first 90s, EXPENSIVE @ ${config.EXPENSIVE_BUY_AT_SECS.join('/')}s, ${config.ORDER_SHARES}sh per order`);
        }

        const [upPrice, downPrice] = await Promise.all([
          polymarket.getMidpoint(upTokenId),
          polymarket.getMidpoint(downTokenId),
        ]);

        state.lastCheck = {
          timestamp: new Date().toISOString(),
          windowStart,
          windowEnd,
          secondsRemaining: windowEnd - nowSec,
          upPrice,
          downPrice,
        };

        const win = state.currentWindow;

        if (win && nowSec < windowEnd) {
          const elapsed = nowSec - win.windowStart;

          // CHEAP — one 50-share buy per 30-second block in the first 90s.
          // Side re-evaluated fresh here, so it can flip between blocks.
          config.CHEAP_BUY_BUCKETS.forEach((bucket, i) => {
            const key = 'cheap-' + i;
            if (win.fired.includes(key)) return;
            if (elapsed >= bucket.start && elapsed < bucket.end) {
              const side = cheapSide(upPrice, downPrice);
              win.fired.push(key);
              fireEntry(win, side, config.ORDER_SHARES, priceOf(side, upPrice, downPrice), upTokenId, downTokenId,
                `cheap buy #${i + 1} — t ${bucket.start}-${bucket.end}s (${side} is cheap at $${priceOf(side, upPrice, downPrice).toFixed(2)})`);
            }
          });

          // EXPENSIVE — one 50-share buy at each scheduled second. Side
          // re-evaluated fresh at each tick, so it can flip between buys.
          config.EXPENSIVE_BUY_AT_SECS.forEach((sec) => {
            const key = 'exp-' + sec;
            if (win.fired.includes(key)) return;
            if (elapsed >= sec) {
              const side = expensiveSide(upPrice, downPrice);
              win.fired.push(key);
              fireEntry(win, side, config.ORDER_SHARES, priceOf(side, upPrice, downPrice), upTokenId, downTokenId,
                `expensive buy @ t=${sec}s (${side} is expensive at $${priceOf(side, upPrice, downPrice).toFixed(2)})`);
            }
          });

          // Snapshot both sides' prices on every tick while the window is
          // still open. Whichever snapshot ends up closest to windowEnd is
          // what resolveWindow() treats as "the last second of the window".
          win.finalUpPrice = upPrice;
          win.finalDownPrice = downPrice;
        }
      } else {
        log('No live market found for current window yet.');
      }
    } catch (e) {
      log('ERROR taking live snapshot / checking current window:', e.message);
      state.lastError = e.message;
    }

    // 4) Extra safety net: in case the current window's time ran out
    //    again during step 3 (e.g. a slow network call straddled the
    //    boundary), catch it here too rather than waiting a full extra
    //    poll interval.
    try {
      if (state.currentWindow && nowSec >= state.currentWindow.windowEnd) {
        state.pendingResolutions.push(state.currentWindow);
        state.currentWindow = null;
      }
    } catch (e) {
      log('ERROR handing off closed window (late):', e.message);
      state.lastError = e.message;
    }

    saveState(state);
  } finally {
    tickRunning = false;
  }
}

function startBotLoop() {
  log(`Bot started (time-scheduled cheap/expensive, ${config.WINDOW_MINUTES}-min window). Bankroll: $${config.STARTING_BANKROLL} | ${config.ORDER_SHARES}sh per order | CHEAP: ${config.CHEAP_BUY_BUCKETS.length} buys in first 90s (${config.CHEAP_BUY_BUCKETS.map((b) => b.start + '-' + b.end).join(' / ')}) | EXPENSIVE: ${config.EXPENSIVE_BUY_AT_SECS.length} buys @ ${config.EXPENSIVE_BUY_AT_SECS.join('/')}s | rides to resolution, no TP`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
