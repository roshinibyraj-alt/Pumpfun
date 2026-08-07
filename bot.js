// ============================================================
// bot.js — fixed side-pattern + immediate-entry strategy, v14. NO
// candle signal, NO hedge, NO entry wait, NO take-profit exit. Per
// window:
//   1. On new window detection, the side comes from config.BET_PATTERN
//      at state.patternIndex, which then advances (wrapping) — no
//      candles, no strategy.detectPattern(), no CHOP/NONE skip. Every
//      window trades.
//   2. Entry fires IMMEDIATELY, the first tick the window is seen, as
//      a genuine TAKER buy at whatever price is showing right then.
//      No wait, no price condition.
//   3. Sized via a LINEAR win/loss ladder (state.currentBet): a LOSS
//      adds config.LINEAR_STEP_USD to the next bet, a WIN subtracts
//      it, floored at config.ORDER_NOTIONAL_USD. To make this
//      genuinely reflect the most recently CLOSED window (not one
//      further back), tick() resolves any closed window FIRST, before
//      creating the next window and firing its entry.
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

// Reads the current rung of the linear win/loss ladder. Does NOT
// mutate it — the ladder is only ever adjusted inside resolveWindow(),
// right when a trade's outcome becomes known, so that by the time this
// runs (for the NEXT window) it already reflects the most recently
// resolved trade. Self-initializes to the base bet on first run.
function currentLadderNotional(state) {
  if (state.currentBet == null) state.currentBet = config.ORDER_NOTIONAL_USD;
  return state.currentBet;
}

// Fires an immediate taker buy at the current price. Only ever called
// once, the first tick a window's position is still null. Mutates
// win.position in place.
function fireEntry(win, ownPrice, upTokenId, downTokenId) {
  const reason = `immediate entry — window start, firing at current price $${ownPrice.toFixed(2)}, no wait`;
  const tokenId = win.side === 'UP' ? upTokenId : downTokenId;
  win.position = strategy.openPosition(win.windowStart, win.windowEnd, win.side, tokenId, win.notional, ownPrice, reason, config);
  log(`ENTRY (TAKER): pattern ${win.pattern} -> ${win.side} @ $${ownPrice.toFixed(2)}, $${win.notional} notional (ladder) = ${win.position.shares} shares (fee $${win.position.fillFee.toFixed(5)}) — ${reason}`);
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

    // Step the linear win/loss ladder right here, the moment the
    // outcome is known — this must happen BEFORE the next window is
    // sized (tick() resolves closed windows before creating the next
    // one specifically so this update lands in time).
    if (state.currentBet == null) state.currentBet = config.ORDER_NOTIONAL_USD;
    if (pos.resolvedWon) {
      state.currentBet = Math.max(config.ORDER_NOTIONAL_USD, Math.round((state.currentBet - config.LINEAR_STEP_USD) * 100) / 100);
    } else {
      state.currentBet = Math.round((state.currentBet + config.LINEAR_STEP_USD) * 100) / 100;
    }
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
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | pattern ${win.pattern || '(none)'} (${win.signal}) | ${traded ? `traded ${win.side} (${win.position.shares}sh @ $${win.position.fillPrice})` : 'SKIPPED (' + win.skipReason + ')'} | fees $${fees.toFixed(5)} | est. rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | ${traded ? (isLoss ? 'LOSS' : 'WIN') : 'no trade'} | next bet -> $${state.currentBet} | bankroll $${state.bankroll}`
  );
  return true;
}

async function tick() {
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) Hand off the current window for resolution the moment its time
  //    is up — BEFORE we look at creating the next window. Order
  //    matters here: the linear ladder must be stepped from the
  //    outcome of the window that just closed before we size the next
  //    one, or sizing would lag the true win/loss by one window.
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

  // 2) Resolution pass — runs before any new-window sizing decision.
  //    Isolated in its own try/catch so a hiccup here can't block the
  //    rest of the tick.
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

  // 3) Market snapshot, new-window creation (sizing now reflects
  //    whatever the resolution pass above just settled), and immediate
  //    entry firing.
  try {
    const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);

    if (found) {
      const { market, windowStart, windowEnd } = found;
      const { upTokenId, downTokenId } = polymarket.parseTokens(market);

      if (!state.currentWindow || state.currentWindow.windowStart !== windowStart) {
        // Safety net: if for some reason step 1 didn't already catch
        // a stale window (e.g. windowStart changed without our local
        // clock yet reading past windowEnd), hand it off here too.
        if (state.currentWindow) {
          state.pendingResolutions.push(state.currentWindow);
          log(`Window ${state.currentWindow.windowStart} closed -> pending resolution (late detection)`);
        }

        const { side, patternLabel } = nextPatternSide(state);
        const notional = currentLadderNotional(state);

        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          notional,
          pattern: patternLabel,
          signal: 'FIXED_PATTERN_LINEAR_LADDER',
          side,
          position: null,
          skipped: false,
          skipReason: null,
        };

        log(`Window ${windowStart}: side ${side} (${patternLabel}), notional $${notional} [ladder]`);
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
}

function startBotLoop() {
  log(`Bot started (fixed pattern ${config.BET_PATTERN.join('')} + immediate entry, no hedge, no TP — rides to resolution). Bankroll: $${config.STARTING_BANKROLL} | entry fires instantly at window start | resolution win threshold $${config.RESOLUTION_WIN_THRESHOLD} | linear ladder: base/floor $${config.ORDER_NOTIONAL_USD}, step $${config.LINEAR_STEP_USD} (+step on loss, -step on win)`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
