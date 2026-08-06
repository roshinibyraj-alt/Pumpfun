// ============================================================
// bot.js — candle-pattern side-selection + timed forced-entry
// strategy, v12. NO hedge, NO dual-side dip-buy, NO resting-order
// entry, NO take-profit exit. Per window:
//   1. On new window detection, fetch the last config.CANDLE_LOOKBACK
//      CLOSED real BTC/ETH candles (Binance, config.CANDLE_INTERVAL)
//      and run strategy.detectPattern() to pick a side (or CHOP/NONE).
//   2. CHOP/NONE -> window SKIPPED entirely, no order.
//   3. A directional signal -> every tick from window start:
//        - while secondsIntoWindow < ENTRY_WAIT_SECONDS: fire an
//          IMMEDIATE (taker) buy the instant the signaled side's price
//          is <= EARLY_ENTRY_TRIGGER_PRICE.
//        - once secondsIntoWindow >= ENTRY_WAIT_SECONDS and no entry
//          has fired yet: fire an IMMEDIATE (taker) buy at whatever
//          the current price is, no price condition.
//      Every directionally-signaled window therefore gets exactly one
//      trade, always sized at $config.ORDER_NOTIONAL_USD worth of
//      shares at the fill price — shares = notional / fillPrice.
//   4. Once filled, the position rides naked all the way to real
//      resolution — there is no take-profit exit anymore. Every tick
//      we snapshot both sides' live prices onto the window; whichever
//      snapshot lands closest to windowEnd is treated as "the last
//      second of the window". If either side's price in that final
//      snapshot is >= config.RESOLUTION_WIN_THRESHOLD, that side is
//      declared the winner immediately at resolution time — no need
//      to wait on the real market to fully settle. If neither side
//      had cleared the threshold by that last tick, resolution falls
//      back to polling the real market price until it converges.
//   5. NO martingale of any kind: every trade uses the same fixed
//      config.ORDER_NOTIONAL_USD regardless of win/loss history. There
//      is no loss-streak tracking, no doubling, no size adjustment
//      based on past outcomes.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const binance = require('./binance');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// Fetches the recent candle pattern and returns a detectPattern()-shaped
// result. Never throws — on any fetch/parsing error it degrades to an
// ERROR signal (skip the window) rather than trading blind.
async function getPatternSignal() {
  try {
    const recent = await binance.getRecentClosedCandles(config.ASSET, config.CANDLE_INTERVAL, config.CANDLE_LOOKBACK);
    const colors = strategy.colorsFromCandles(recent);
    const result = strategy.detectPattern(colors);
    log(`Candle pattern (${config.ASSET.toUpperCase()} ${config.CANDLE_INTERVAL}, last ${colors.length}): ${colors.join('') || '(none)'} -> pattern ${result.pattern || '(none)'} / signal ${result.signal}${result.side ? ' / side ' + result.side : ''}`);
    return result;
  } catch (e) {
    log('ERROR fetching candle pattern (skipping window):', e.message);
    return { pattern: null, signal: 'ERROR', side: null };
  }
}

// Checks whether the entry condition is met this tick and fires an
// immediate taker buy if so. Only ever called while win.position is
// still null. Mutates win.position in place.
function maybeFireEntry(win, ownPrice, upTokenId, downTokenId, nowSec) {
  const secondsIntoWindow = nowSec - win.windowStart;
  let reason = null;

  if (secondsIntoWindow < config.ENTRY_WAIT_SECONDS) {
    if (ownPrice <= config.EARLY_ENTRY_TRIGGER_PRICE) {
      reason = `early trigger — price $${ownPrice.toFixed(2)} <= $${config.EARLY_ENTRY_TRIGGER_PRICE} at ${secondsIntoWindow}s into window`;
    }
  } else {
    reason = `forced entry — ${config.ENTRY_WAIT_SECONDS}s elapsed with no early trigger, firing at current price $${ownPrice.toFixed(2)} regardless of level`;
  }

  if (!reason) return; // still waiting, no condition met yet

  const tokenId = win.side === 'UP' ? upTokenId : downTokenId;
  win.position = strategy.openPosition(win.windowStart, win.windowEnd, win.side, tokenId, win.notional, ownPrice, reason, config);
  log(`ENTRY (TAKER): pattern ${win.pattern} (${win.signal}) -> ${win.side} @ $${ownPrice.toFixed(2)}, $${win.notional} notional = ${win.position.shares} shares (fee $${win.position.fillFee.toFixed(5)}) — ${reason}`);
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
// still ambiguous). Settles the single position (if any was taken) at
// a fixed notional. Returns true if resolved this call, false if
// still waiting on convergence.
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

  let cost = 0, payout = 0, fees = 0, rebates = 0;
  const pos = win.position;
  const traded = !!pos;

  if (pos) {
    // Position rides naked all the way to resolution — no TP exit.
    const f = pos.fillFee || 0;
    const r = pos.fillRebate || 0;
    cost = pos.shares * pos.fillPrice + f;
    payout = (pos.side === wonSide ? pos.shares * 1 : 0) + r;
    pos.resolvedWon = pos.side === wonSide;
    pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
    fees += f;
    rebates += r;
    pos.cost = Math.round(cost * 100000) / 100000;
    pos.payout = Math.round(payout * 100000) / 100000;
    pos.pnl = Math.round((payout - cost) * 100000) / 100000;
    pos.settledAt = new Date().toISOString();
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;
  const isLoss = traded ? pnl < 0 : null;

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    pattern: win.pattern,
    signal: win.signal,
    side: win.side,
    traded,
    skipped: win.skipped,
    skipReason: win.skipReason,
    notional: win.notional,
    position: win.position,
    wonSide,
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
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | pattern ${win.pattern || '(none)'} (${win.signal}) | ${traded ? `traded ${win.side} (${win.position.shares}sh @ $${win.position.fillPrice})` : 'SKIPPED (' + win.skipReason + ')'} | fees $${fees.toFixed(5)} | est. rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | ${traded ? (isLoss ? 'LOSS' : 'WIN') : 'no trade'} | bankroll $${state.bankroll}`
  );
  return true;
}

async function tick() {
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);

    if (found) {
      const { market, windowStart, windowEnd } = found;
      const { upTokenId, downTokenId } = polymarket.parseTokens(market);

      if (!state.currentWindow || state.currentWindow.windowStart !== windowStart) {
        if (state.currentWindow) {
          state.pendingResolutions.push(state.currentWindow);
          log(`Window ${state.currentWindow.windowStart} closed -> pending resolution`);
        }

        const notional = config.ORDER_NOTIONAL_USD;
        const patternResult = await getPatternSignal();

        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          notional,
          pattern: patternResult.pattern,
          signal: patternResult.signal,
          side: patternResult.side,
          position: null,
          skipped: !patternResult.side,
          skipReason: patternResult.side
            ? null
            : (patternResult.signal === 'ERROR' ? 'candle fetch failed' : 'no directional signal (chop/insufficient data)'),
        };

        if (state.currentWindow.skipped) {
          log(`Window ${windowStart}: SKIPPED — ${state.currentWindow.skipReason}`);
        }
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

      if (win.side && !win.position && !win.skipped) {
        const ownPrice = win.side === 'UP' ? upPrice : downPrice;
        maybeFireEntry(win, ownPrice, upTokenId, downTokenId, nowSec);
      }

      // Snapshot both sides' prices on every tick while the window is
      // still open. Whichever snapshot ends up closest to windowEnd is
      // what resolveWindow() treats as "the last second of the
      // window" for immediate-winner detection.
      if (nowSec < windowEnd) {
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

  // Proactively hand off the current window once its time is up, even if
  // we haven't yet detected the NEXT window this tick — starts resolution
  // checks promptly instead of waiting on window-rollover detection.
  try {
    if (state.currentWindow && nowSec >= state.currentWindow.windowEnd) {
      state.pendingResolutions.push(state.currentWindow);
      state.currentWindow = null;
    }
  } catch (e) {
    log('ERROR handing off closed window:', e.message);
    state.lastError = e.message;
  }

  // Resolution pass — isolated so a hiccup above can't block resolving
  // windows that are already closed and just waiting on convergence.
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

  saveState(state);
}

function startBotLoop() {
  log(`Bot started (candle-pattern + timed forced entry, no hedge, no martingale, no TP — rides to resolution). Bankroll: $${config.STARTING_BANKROLL} | candles ${config.ASSET.toUpperCase()} ${config.CANDLE_INTERVAL} x${config.CANDLE_LOOKBACK} | early trigger <= $${config.EARLY_ENTRY_TRIGGER_PRICE} within ${config.ENTRY_WAIT_SECONDS}s, else forced at market | resolution win threshold $${config.RESOLUTION_WIN_THRESHOLD} | fixed notional $${config.ORDER_NOTIONAL_USD} every trade`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
