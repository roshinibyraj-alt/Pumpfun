// ============================================================
// bot.js — fixed side-pattern + immediate-entry strategy, v13. NO
// candle signal, NO hedge, NO entry wait, NO take-profit exit. Per
// window:
//   1. On new window detection, the side comes from config.BET_PATTERN
//      at state.patternIndex, which then advances (wrapping) — no
//      candles, no strategy.detectPattern(), no CHOP/NONE skip. Every
//      window trades.
//   2. Entry fires IMMEDIATELY, the first tick the window is seen, as
//      a genuine TAKER buy at whatever price is showing right then.
//      No wait, no price condition.
//   3. Sized at $config.ORDER_NOTIONAL_USD, but alternating with
//      state.doubleToggle: base, double, base, double, ... one step
//      per trade, advancing regardless of win/loss and independent of
//      patternIndex — NOT a loss-chasing martingale.
//   4. Once filled, the position rides naked all the way to real
//      resolution — there is no take-profit exit. Every tick we
//      snapshot both sides' live prices onto the window; whichever
//      snapshot lands closest to windowEnd is treated as "the last
//      second of the window". If either side's price in that final
//      snapshot is >= config.RESOLUTION_WIN_THRESHOLD, that side is
//      declared the winner immediately at resolution time — no need
//      to wait on the real market to fully settle. If neither side
//      had cleared the threshold by that last tick, resolution falls
//      back to polling the real market price until it converges.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// Picks the next side off config.BET_PATTERN using state.patternIndex,
// then advances the index (wrapping). Self-initializes on first run.
function nextPatternSide(state) {
  if (state.patternIndex == null) state.patternIndex = 0;
  const pattern = config.BET_PATTERN;
  const idx = state.patternIndex % pattern.length;
  const side = pattern[idx];
  state.patternIndex = (state.patternIndex + 1) % pattern.length;
  return { side, patternLabel: pattern.join('') + ` [pos ${idx + 1}/${pattern.length}]` };
}

// Picks this trade's notional using state.doubleToggle, then flips the
// toggle for next time. Purely a trade-count alternation — completely
// independent of win/loss outcome and of patternIndex. Self-initializes
// on first run.
function nextNotional(state) {
  if (state.doubleToggle == null) state.doubleToggle = false; // false = base next, true = double next
  const notional = state.doubleToggle
    ? Math.round(config.ORDER_NOTIONAL_USD * config.DOUBLE_MULTIPLIER * 100) / 100
    : config.ORDER_NOTIONAL_USD;
  const wasDouble = state.doubleToggle;
  state.doubleToggle = !state.doubleToggle;
  return { notional, wasDouble };
}

// Fires an immediate taker buy at the current price. Only ever called
// once, the first tick a window's position is still null. Mutates
// win.position in place.
function fireEntry(win, ownPrice, upTokenId, downTokenId) {
  const reason = `immediate entry — window start, firing at current price $${ownPrice.toFixed(2)}, no wait`;
  const tokenId = win.side === 'UP' ? upTokenId : downTokenId;
  win.position = strategy.openPosition(win.windowStart, win.windowEnd, win.side, tokenId, win.notional, ownPrice, reason, config);
  log(`ENTRY (TAKER): pattern ${win.pattern} -> ${win.side} @ $${ownPrice.toFixed(2)}, $${win.notional} notional${win.isDouble ? ' (DOUBLE)' : ' (base)'} = ${win.position.shares} shares (fee $${win.position.fillFee.toFixed(5)}) — ${reason}`);
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

        const { side, patternLabel } = nextPatternSide(state);
        const { notional, wasDouble } = nextNotional(state);

        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          notional,
          isDouble: wasDouble,
          pattern: patternLabel,
          signal: wasDouble ? 'FIXED_PATTERN_DOUBLE' : 'FIXED_PATTERN_BASE',
          side,
          position: null,
          skipped: false,
          skipReason: null,
        };

        log(`Window ${windowStart}: side ${side} (${patternLabel}), notional $${notional}${wasDouble ? ' [DOUBLE]' : ' [base]'}`);
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

      if (win.side && !win.position) {
        const ownPrice = win.side === 'UP' ? upPrice : downPrice;
        fireEntry(win, ownPrice, upTokenId, downTokenId);
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
  log(`Bot started (fixed pattern ${config.BET_PATTERN.join('')} + immediate entry, no hedge, no TP — rides to resolution). Bankroll: $${config.STARTING_BANKROLL} | entry fires instantly at window start | resolution win threshold $${config.RESOLUTION_WIN_THRESHOLD} | sizing alternates $${config.ORDER_NOTIONAL_USD} base / $${Math.round(config.ORDER_NOTIONAL_USD * config.DOUBLE_MULTIPLIER * 100) / 100} double, one step per trade`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
