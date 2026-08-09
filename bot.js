// ============================================================
// bot.js — time-scheduled cheap/expensive buys, v17. Per 15-minute
// window (900 seconds), schedule scaled ×3 from the 5-minute version:
//
//   CHEAP side (the side with the LOWER midpoint), one 50-share
//   buy at each of:
//     t = 90s      -> buy CHEAP, 50 shares
//     t = 180s     -> buy CHEAP, 50 shares
//     t = 270s     -> buy CHEAP, 50 shares
//
//   EXPENSIVE side (the side with the HIGHER midpoint), one
//   100-share buy at each of:
//     t = 630s     -> buy EXPENSIVE, 100 shares
//     t = 720s     -> buy EXPENSIVE, 100 shares
//     t = 810s     -> buy EXPENSIVE, 100 shares
//
// Cheap/expensive is re-evaluated FRESH at each scheduled tick
// from the live midpoints — sides may flip mid-window and each
// order simply follows whichever side is cheap/expensive right
// then. Cheap buys are exactly config.CHEAP_ORDER_SHARES (50) shares,
// expensive buys exactly config.EXPENSIVE_ORDER_SHARES (100) shares,
// regardless of cost — no ladder, no pattern, no hedge.
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
// Cheap = lower midpoint, Expensive = higher midpoint.
function cheapSide(upPrice, downPrice) { return upPrice <= downPrice ? 'UP' : 'DOWN'; }
function expensiveSide(upPrice, downPrice) { return upPrice >= downPrice ? 'UP' : 'DOWN'; }

// Builds an ALREADY-FILLED entry at the moment a scheduled buy fires.
// Entries fill at the current midpoint; size is always exactly
// config.CHEAP_ORDER_SHARES / config.EXPENSIVE_ORDER_SHARES shares.
// Fee/rebate follow config.ENTRY_IS_MAKER
// (see the header comment — taker default, maker opt-in).
function makeEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason) {
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
  const entry = makeEntry(win, side, shares, fillPrice, upTokenId, downTokenId, reason);
  win.entries.push(entry);
  log(`ENTRY: ${side} ${shares}sh @ $${fillPrice.toFixed(2)} | fee $${entry.fillFee.toFixed(4)} | rebate $${entry.fillRebate.toFixed(4)} — ${reason}`);
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
    totalRebates: Math.round(rebates * 100000) / 100000,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    isLoss,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | ${entries.length} entries (${entries.map((e) => e.side).join(', ') || 'none'}) | payout $${payout.toFixed(2)} | cost $${cost.toFixed(2)} | fees $${fees.toFixed(5)} | rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | bankroll $${state.bankroll}`
  );
  return true;
}

// Computes live unrealized P&L for the open window using the latest
// midpoint snapshot (state.lastCheck). Used by the dashboard's
// /api/state so positions are marked to market in real time.
function computeUnrealized(state) {
  const win = state.currentWindow;
  const lc = state.lastCheck || {};
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
            fired: [],    // schedule keys already executed: cheap-90/180/270, exp-630/720/810
            finalUpPrice: null,
            finalDownPrice: null,
          };

          log(`Window ${windowStart}: CHEAP ${config.CHEAP_ORDER_SHARES}sh @ ${config.CHEAP_BUY_AT_SECS.join('/')}s | EXPENSIVE ${config.EXPENSIVE_ORDER_SHARES}sh @ ${config.EXPENSIVE_BUY_AT_SECS.join('/')}s | ${config.ENTRY_IS_MAKER ? 'MAKER' : 'TAKER'} fills`);
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

          // CHEAP — one 50-share buy at each scheduled second. Each has a
          // BUY_FIRE_VALIDITY_SECS validity window (sec .. sec+validity)
          // so a mid-window restart doesn't dump all missed cheap buys at
          // once. Side re-evaluated fresh here, so it can flip between
          // buys.
          config.CHEAP_BUY_AT_SECS.forEach((sec, i) => {
            const key = 'cheap-' + sec;
            if (win.fired.includes(key)) return;
            if (elapsed >= sec && elapsed < sec + config.BUY_FIRE_VALIDITY_SECS) {
              const side = cheapSide(upPrice, downPrice);
              win.fired.push(key);
              fireEntry(win, side, config.CHEAP_ORDER_SHARES, priceOf(side, upPrice, downPrice), upTokenId, downTokenId,
                `cheap buy #${i + 1} — t=${sec}s (${side} is cheap at $${priceOf(side, upPrice, downPrice).toFixed(2)})`);
            }
          });

          // EXPENSIVE — one 100-share buy at each scheduled second. Each
          // also gets a BUY_FIRE_VALIDITY_SECS validity window. Side
          // re-evaluated fresh.
          config.EXPENSIVE_BUY_AT_SECS.forEach((sec) => {
            const key = 'exp-' + sec;
            if (win.fired.includes(key)) return;
            if (elapsed >= sec && elapsed < sec + config.BUY_FIRE_VALIDITY_SECS) {
              const side = expensiveSide(upPrice, downPrice);
              win.fired.push(key);
              fireEntry(win, side, config.EXPENSIVE_ORDER_SHARES, priceOf(side, upPrice, downPrice), upTokenId, downTokenId,
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
  log(`Bot started (time-scheduled cheap/expensive, ${config.WINDOW_MINUTES}-min window). Bankroll: $${config.STARTING_BANKROLL} | CHEAP ${config.CHEAP_ORDER_SHARES}sh @ ${config.CHEAP_BUY_AT_SECS.join('/')}s | EXPENSIVE ${config.EXPENSIVE_ORDER_SHARES}sh @ ${config.EXPENSIVE_BUY_AT_SECS.join('/')}s | ${config.ENTRY_IS_MAKER ? 'MAKER fills (20% rebate)' : 'TAKER fills (0.07 fee)'} | rides to resolution, no TP`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick, computeUnrealized };
