// ============================================================
// bot.js — ladder + counter-bet lock strategy. Every tick
// (POLL_INTERVAL_MS):
//   1. Detects the current window. If it's new, places a fresh
//      12-rung ladder (6 UP + 6 DOWN) — all independent.
//   2. For each rung in the currently-open window: checks if its
//      base leg should fill (price crossed the rung level), or
//      if its counter leg should fill (price crossed the lock
//      price) — locking a guaranteed profit the instant it does.
//   3. For any rung whose window has already closed with an
//      unhedged base fill, resolves it the normal way — real
//      token price convergence, no fallback.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function processRungFill(rung, upPrice, downPrice, state) {
  if (rung.status === 'waiting_base') {
    const ownPrice = rung.side === 'UP' ? upPrice : downPrice;
    if (ownPrice <= rung.rungPrice) {
      rung.baseFillPrice = rung.rungPrice;
      rung.baseFilledAt = new Date().toISOString();
      rung.status = 'base_filled';
      rung.counterPrice = strategy.counterPriceFor(rung.rungPrice, config.LOCK_SPREAD);
      const counterSide = rung.side === 'UP' ? 'DOWN' : 'UP';
      log(`FILL base ${rung.side} @ $${rung.rungPrice} (window ${rung.windowStart}) -> counter order ${counterSide} @ $${rung.counterPrice}`);
    }
  } else if (rung.status === 'base_filled') {
    const oppPrice = rung.side === 'UP' ? downPrice : upPrice;
    if (oppPrice <= rung.counterPrice) {
      rung.counterFillPrice = rung.counterPrice;
      rung.counterFilledAt = new Date().toISOString();
      rung.status = 'locked';
      rung.lockedProfit = Math.round(rung.shares * (1 - rung.baseFillPrice - rung.counterFillPrice) * 100) / 100;
      rung.pnl = rung.lockedProfit;
      rung.settledAt = rung.counterFilledAt;
      state.bankroll = Math.round((state.bankroll + rung.lockedProfit) * 100) / 100;
      log(`LOCKED ${rung.side}-rung @ $${rung.rungPrice} | base ${rung.baseFillPrice} + counter ${rung.counterFillPrice} | profit $${rung.lockedProfit} | bankroll $${state.bankroll}`);
    }
  }
}

// For a rung whose base leg filled but counter never did before the
// window closed. Same no-fallback resolution rule as before: check the
// held token's own price convergence, wait if still ambiguous.
async function resolveUnhedgedRung(rung, state) {
  let tokenPrice;
  try {
    tokenPrice = await polymarket.getMidpoint(rung.tokenId);
  } catch (e) {
    log('ERROR fetching resolution price for unhedged rung:', e.message);
    return; // try again next tick
  }

  let won;
  if (tokenPrice >= config.RESOLUTION_WIN_THRESHOLD) won = true;
  else if (tokenPrice <= config.RESOLUTION_LOSS_THRESHOLD) won = false;
  else return; // not converged yet, try again next tick

  const cost = rung.shares * rung.baseFillPrice;
  const payout = won ? rung.shares * 1 : 0;
  rung.pnl = Math.round((payout - cost) * 100) / 100;
  rung.resolvedWon = won;
  rung.status = 'resolved';
  rung.finalTokenPrice = tokenPrice;
  rung.settledAt = new Date().toISOString();
  state.bankroll = Math.round((state.bankroll + rung.pnl) * 100) / 100;
  log(`RESOLVED unhedged ${rung.side}-rung @ $${rung.rungPrice} (window ${rung.windowStart}) | settled ${tokenPrice.toFixed(3)} | ${won ? 'WIN' : 'LOSS'} | pnl ${rung.pnl} | bankroll $${state.bankroll}`);
}

function sweepCompleted(state) {
  const done = [];
  const remaining = [];
  for (const rung of state.activeRungs) {
    if (rung.status === 'locked' || rung.status === 'resolved' || rung.status === 'expired_unfilled') {
      done.push(rung);
    } else {
      remaining.push(rung);
    }
  }
  if (done.length) {
    state.completedRungs.push(...done);
    state.activeRungs = remaining;
  }
}

async function tick() {
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);

    if (found) {
      const { market, windowStart, windowEnd } = found;
      const { upTokenId, downTokenId } = polymarket.parseTokens(market);

      const hasRungsForThisWindow = state.activeRungs.some((r) => r.windowStart === windowStart);
      if (!hasRungsForThisWindow) {
        const newRungs = strategy.buildRungs(windowStart, windowEnd, upTokenId, downTokenId, config);
        state.activeRungs.push(...newRungs);
        log(`Window ${windowStart}: placed ${newRungs.length} rungs (${config.RUNG_PRICES.join('/')} on both sides, ${config.SHARES_PER_RUNG} shares each)`);
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

      for (const rung of state.activeRungs) {
        if (rung.windowStart === windowStart && (rung.status === 'waiting_base' || rung.status === 'base_filled')) {
          processRungFill(rung, upPrice, downPrice, state);
        }
      }
    } else {
      log('No live market found for current window yet.');
    }
  } catch (e) {
    log('ERROR taking live snapshot / checking current window:', e.message);
    state.lastError = e.message;
  }

  // Resolution / expiry pass — isolated from the block above so a hiccup
  // finding the CURRENT window can't block resolving rungs from a window
  // that already closed.
  try {
    for (const rung of state.activeRungs) {
      if (rung.status === 'base_filled' && nowSec >= rung.windowEnd) {
        await resolveUnhedgedRung(rung, state);
      } else if (rung.status === 'waiting_base' && nowSec >= rung.windowEnd) {
        rung.status = 'expired_unfilled';
        rung.pnl = 0;
        rung.settledAt = new Date().toISOString();
      }
    }
    sweepCompleted(state);
    if (!state.lastError) state.lastError = null;
  } catch (e) {
    log('ERROR in resolution pass:', e.message);
    state.lastError = e.message;
  }

  saveState(state);
}

function startBotLoop() {
  log(`Bot started (ladder+lock v2). Trading enabled: ${config.TRADING_ENABLED} | Bankroll: $${config.STARTING_BANKROLL} | Rungs: ${config.RUNG_PRICES.join('/')} | ${config.SHARES_PER_RUNG} shares/rung | lock spread $${config.LOCK_SPREAD}`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
