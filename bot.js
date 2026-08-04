// ============================================================
// bot.js — ladder + counter-bet strategy, v3-reversed (breakout
// entry). Base leg now fills when price rises TO OR ABOVE a rung
// (momentum/breakout) instead of dropping to or below it (dip-buy).
// Everything downstream — hedging, resolution, pnl — is unchanged
// and direction-agnostic. Every fill — whether it came from
// an original base rung or a counter order triggered by one —
// just accumulates into a running total of UP shares and DOWN
// shares held for that window. At window close, the whole
// accumulated position resolves ONCE against the real outcome:
//   payout = (winning side's total shares) × $1
//   pnl = payout − (total cost of everything bought that window)
// This naturally covers full hedges, partial hedges, and
// unhedged single fills with the same formula — no special
// casing needed.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// Pure status/fill-price bookkeeping — no bankroll or pnl touched here.
// Resolution only ever happens once, at window close, in resolveWindow().
function processRungFill(rung, upPrice, downPrice) {
  if (rung.status === 'waiting_base') {
    const ownPrice = rung.side === 'UP' ? upPrice : downPrice;
    // Reversed (v3r): breakout/momentum entry — fire when price rises
    // TO OR ABOVE the rung, instead of dropping to or below it.
    if (ownPrice >= rung.rungPrice) {
      rung.baseFillPrice = rung.rungPrice;
      rung.baseFilledAt = new Date().toISOString();
      rung.status = 'base_filled';
      rung.counterPrice = strategy.counterPriceFor(rung.rungPrice, config.LOCK_SPREAD);
      const counterSide = rung.side === 'UP' ? 'DOWN' : 'UP';
      log(`FILL base ${rung.side} @ $${rung.rungPrice} -> counter order ${counterSide} @ $${rung.counterPrice}`);
    }
  } else if (rung.status === 'base_filled') {
    const oppPrice = rung.side === 'UP' ? downPrice : upPrice;
    if (oppPrice <= rung.counterPrice) {
      rung.counterFillPrice = rung.counterPrice;
      rung.counterFilledAt = new Date().toISOString();
      rung.status = 'counter_filled';
      log(`COUNTER FILLED ${rung.side}-rung @ $${rung.rungPrice} | now holding both legs, awaiting window resolution`);
    }
  }
}

// Attempts to resolve a closed window: checks the real outcome (no
// fallback — waits if still ambiguous), sums every fill (base AND
// counter, from every rung) into total UP/DOWN shares and cost, and
// settles the whole accumulated position in one shot. Returns true if
// resolved this call, false if still waiting on convergence.
async function resolveWindow(win, state) {
  let upTokenPrice;
  try {
    upTokenPrice = await polymarket.getMidpoint(win.upTokenId);
  } catch (e) {
    log(`ERROR checking resolution for window ${win.windowStart}:`, e.message);
    return false;
  }

  let wonSide;
  if (upTokenPrice >= config.RESOLUTION_WIN_THRESHOLD) wonSide = 'UP';
  else if (upTokenPrice <= config.RESOLUTION_LOSS_THRESHOLD) wonSide = 'DOWN';
  else return false; // not converged yet, try again next tick

  let totalUpShares = 0, totalUpCost = 0, totalDownShares = 0, totalDownCost = 0;
  for (const rung of win.rungs) {
    if (rung.baseFillPrice !== null) {
      if (rung.side === 'UP') { totalUpShares += rung.shares; totalUpCost += rung.shares * rung.baseFillPrice; }
      else { totalDownShares += rung.shares; totalDownCost += rung.shares * rung.baseFillPrice; }
    }
    if (rung.counterFillPrice !== null) {
      // the counter leg is always on the OPPOSITE token from rung.side
      if (rung.side === 'UP') { totalDownShares += rung.shares; totalDownCost += rung.shares * rung.counterFillPrice; }
      else { totalUpShares += rung.shares; totalUpCost += rung.shares * rung.counterFillPrice; }
    }
  }

  const payout = wonSide === 'UP' ? totalUpShares * 1 : totalDownShares * 1;
  const cost = totalUpCost + totalDownCost;
  const pnl = Math.round((payout - cost) * 100) / 100;

  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    rungs: win.rungs,
    wonSide,
    totalUpShares,
    totalUpCost: Math.round(totalUpCost * 100) / 100,
    totalDownShares,
    totalDownCost: Math.round(totalDownCost * 100) / 100,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | UP ${totalUpShares}sh/$${totalUpCost.toFixed(2)} | DOWN ${totalDownShares}sh/$${totalDownCost.toFixed(2)} | payout $${payout.toFixed(2)} | pnl $${pnl.toFixed(2)} | bankroll $${state.bankroll}`
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
        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          rungs: strategy.buildRungs(windowStart, windowEnd, upTokenId, downTokenId, config),
        };
        log(`Window ${windowStart}: placed ${state.currentWindow.rungs.length} rungs (${config.RUNG_PRICES.join('/')} on both sides, ${config.SHARES_PER_RUNG} shares each)`);
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

      for (const rung of state.currentWindow.rungs) {
        processRungFill(rung, upPrice, downPrice);
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
  log(`Bot started (ladder v3-reversed/breakout entry, aggregate resolution). Bankroll: $${config.STARTING_BANKROLL} | Rungs: ${config.RUNG_PRICES.join('/')} | ${config.SHARES_PER_RUNG} shares/rung | counter spread $${config.LOCK_SPREAD}`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
