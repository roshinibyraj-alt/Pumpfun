// ============================================================
// bot.js — dip-buy + take-profit strategy, v9. NO hedge, NO
// counter-leg, NO ladder. Per window:
//   1. From ENTRY_CHECK_MINUTE onward, every tick checks whether the
//      UP token's price sits within [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX].
//      The first tick that's true, place TWO resting limit buy orders
//      — UP and DOWN — each for state.currentShareSize shares at
//      config.LIMIT_BUY_PRICE. This only happens once per window.
//   2. Each leg independently fills if its own price falls to
//      LIMIT_BUY_PRICE (genuine maker fill, $0 fee).
//   3. Once a leg fills, a take-profit sell rests at
//      config.TAKE_PROFIT_PRICE. If price rallies back up to it before
//      the window closes, that leg locks in the TP profit (also a
//      genuine maker fill, $0 fee).
//   4. Any leg that never fills its entry order simply expires
//      worthless at window close — no cost. Any leg that filled but
//      never hit TP rides naked to the real window outcome: full win
//      ($1/share) or full loss ($0/share), same convergence-based
//      resolution as before (RESOLUTION_WIN_THRESHOLD / _LOSS_).
//   5. After each window resolves, if its net pnl < $0 that's a loss;
//      consecutive losses are tracked in state.consecutiveLosses. Every
//      time that streak hits a fresh multiple of
//      config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD, state.currentShareSize
//      doubles for the next window. A winning window resets the streak
//      to 0 (share size is NOT reset automatically — see doubling logic
//      below if you want a win to also roll the size back down).
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// Estimate for the Maker Rebates Program: real payouts are pooled and
// proportional to your share of total maker volume in the market, which
// this bot can't observe. As a standard proxy, estimate our rebate as
// MAKER_REBATE_PCT of the taker fee our counterparty would have paid on
// this same fill. This is an expected-value approximation, not a
// guaranteed number.
function estimateMakerRebate(shares, price) {
  const counterpartyTakerFee = shares * config.BASE_TAKER_FEE_RATE * price * (1 - price);
  return Math.round(counterpartyTakerFee * config.MAKER_REBATE_PCT * 100000) / 100000;
}

// Once per window, from ENTRY_CHECK_MINUTE onward: check whether the
// entry condition (UP price inside [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX])
// is true, and if so, arm both legs' resting limit buy orders. Fires
// at most once per window (win.entryTriggered guards it).
function processEntry(win, upPrice, secondsIntoWindow) {
  if (win.entryTriggered) return;
  const entryCheckSeconds = config.ENTRY_CHECK_MINUTE * 60;
  if (secondsIntoWindow < entryCheckSeconds) return;

  if (upPrice >= config.ENTRY_PRICE_MIN && upPrice <= config.ENTRY_PRICE_MAX) {
    const now = new Date().toISOString();
    for (const pos of win.positions) {
      pos.status = 'order_pending';
      pos.orderPlacedAt = now;
    }
    win.entryTriggered = true;
    log(`ENTRY armed @ minute ${config.ENTRY_CHECK_MINUTE} (UP $${upPrice.toFixed(2)} in [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}]) -> placed LIMIT buy UP @ $${config.LIMIT_BUY_PRICE} + DOWN @ $${config.LIMIT_BUY_PRICE}, ${win.positions[0].shares} shares each`);
  }
  // else: condition not met yet this tick — keep checking every tick
  // until it fires or the window closes.
}

// Pure status/fill-price bookkeeping for a single leg — no bankroll or
// pnl touched here. Resolution only happens once, at window close, in
// resolveWindow().
function processPosition(pos, ownPrice) {
  if (pos.status === 'order_pending') {
    if (ownPrice <= pos.orderPrice) {
      pos.fillPrice = pos.orderPrice;
      pos.fillFee = 0; // maker fill -> $0, per Polymarket's fee docs
      pos.fillRebate = estimateMakerRebate(pos.shares, pos.fillPrice);
      pos.filledAt = new Date().toISOString();
      pos.status = 'filled';
      log(`FILL ${pos.side} @ $${pos.fillPrice} (maker, $0 fee, est. rebate $${pos.fillRebate.toFixed(5)}) -> TP order resting @ $${pos.tpPrice}`);
    }
    // else: order still resting unfilled — keep checking each tick.
  } else if (pos.status === 'filled') {
    if (ownPrice >= pos.tpPrice) {
      pos.tpFillPrice = pos.tpPrice;
      pos.tpFillFee = 0; // maker fill -> $0
      pos.tpFillRebate = estimateMakerRebate(pos.shares, pos.tpFillPrice);
      pos.tpFilledAt = new Date().toISOString();
      pos.status = 'tp_filled';
      log(`TP FILLED ${pos.side} @ $${pos.tpFillPrice} (maker, $0 fee, est. rebate $${pos.tpFillRebate.toFixed(5)}) | locked $${((pos.tpFillPrice - pos.fillPrice) * pos.shares).toFixed(2)} profit on ${pos.shares} shares`);
    }
    // else: still waiting for price to rally back up to TP. If the
    // window closes first, this leg rides naked to the real outcome —
    // see resolveWindow().
  }
  // 'inactive' and terminal statuses ('tp_filled', 'order_cancelled',
  // 'resolved_win', 'resolved_loss') need no per-tick handling.
}

// Attempts to resolve a closed window: checks the real outcome (no
// fallback — waits if still ambiguous), settles every leg (filled +
// TP'd, filled + naked, or never-filled), and sums into a single net
// pnl for the window. Returns true if resolved this call, false if
// still waiting on convergence.
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

  let totalCost = 0, totalPayout = 0, totalFees = 0, totalRebates = 0;

  for (const pos of win.positions) {
    if (pos.status === 'tp_filled') {
      const fees = (pos.fillFee || 0) + (pos.tpFillFee || 0);
      const rebates = (pos.fillRebate || 0) + (pos.tpFillRebate || 0);
      pos.cost = pos.shares * pos.fillPrice + fees;
      pos.payout = pos.shares * pos.tpFillPrice + rebates; // rebates treated as income, same convention as before
      totalFees += fees;
      totalRebates += rebates;
    } else if (pos.status === 'filled') {
      // Filled but never hit TP before window close — rides naked to
      // the real outcome.
      const fee = pos.fillFee || 0;
      const rebate = pos.fillRebate || 0;
      pos.cost = pos.shares * pos.fillPrice + fee;
      pos.payout = (pos.side === wonSide ? pos.shares * 1 : 0) + rebate;
      pos.resolvedWon = pos.side === wonSide;
      pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
      totalFees += fee;
      totalRebates += rebate;
    } else if (pos.status === 'order_pending') {
      // Entry order never filled — expires worthless, no cost.
      pos.cost = 0;
      pos.payout = 0;
      pos.status = 'order_cancelled';
      pos.cancelledAt = new Date().toISOString();
    } else {
      // 'inactive' — entry condition never fired this window.
      pos.cost = 0;
      pos.payout = 0;
    }
    pos.pnl = Math.round((pos.payout - pos.cost) * 100000) / 100000;
    pos.settledAt = new Date().toISOString();
    totalCost += pos.cost;
    totalPayout += pos.payout;
  }

  const pnl = Math.round((totalPayout - totalCost) * 100) / 100;
  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;

  // ---- Martingale: consecutive-loss tracking + share-size doubling ----
  const isLoss = pnl < 0;
  if (isLoss) {
    state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
    if (state.consecutiveLosses % config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD === 0) {
      const prevSize = state.currentShareSize;
      state.currentShareSize = state.currentShareSize * 2;
      log(`MARTINGALE: ${state.consecutiveLosses} consecutive losses -> doubling share size ${prevSize} -> ${state.currentShareSize}`);
    }
  } else {
    if (state.consecutiveLosses > 0) {
      log(`Loss streak broken at ${state.consecutiveLosses} (window pnl $${pnl.toFixed(2)} >= 0)`);
    }
    state.consecutiveLosses = 0;
  }

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    shareSize: win.shareSize,
    entryTriggered: win.entryTriggered,
    positions: win.positions,
    wonSide,
    totalFees: Math.round(totalFees * 100000) / 100000,
    totalRebates: Math.round(totalRebates * 100000) / 100000,
    payout: Math.round(totalPayout * 100) / 100,
    cost: Math.round(totalCost * 100) / 100,
    pnl,
    isLoss,
    consecutiveLossesAfter: state.consecutiveLosses,
    shareSizeAfter: state.currentShareSize,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | entry ${win.entryTriggered ? 'triggered' : 'never fired'} | fees $${totalFees.toFixed(5)} | est. rebates $${totalRebates.toFixed(5)} | payout $${totalPayout.toFixed(2)} | pnl $${pnl.toFixed(2)} | ${isLoss ? 'LOSS' : 'WIN'} (streak ${state.consecutiveLosses}) | next share size ${state.currentShareSize} | bankroll $${state.bankroll}`
  );
  return true;
}

async function tick() {
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  // Defaults for martingale sizing state — set once, then persisted.
  if (state.currentShareSize == null) state.currentShareSize = config.BASE_SHARES_PER_SIDE;
  if (state.consecutiveLosses == null) state.consecutiveLosses = 0;

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
        const shareSize = state.currentShareSize;
        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          shareSize,
          entryTriggered: false,
          positions: strategy.buildPositions(windowStart, windowEnd, upTokenId, downTokenId, shareSize, config),
        };
        log(`Window ${windowStart}: armed, waiting for minute ${config.ENTRY_CHECK_MINUTE} + UP price in [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}] to enter (${shareSize} shares/side, buy @ $${config.LIMIT_BUY_PRICE}, TP @ $${config.TAKE_PROFIT_PRICE})`);
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

      processEntry(state.currentWindow, upPrice, nowSec - windowStart);
      for (const pos of state.currentWindow.positions) {
        const ownPrice = pos.side === 'UP' ? upPrice : downPrice;
        processPosition(pos, ownPrice);
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
  log(`Bot started (dip-buy + take-profit v9, no hedge). Bankroll: $${config.STARTING_BANKROLL} | entry @ minute ${config.ENTRY_CHECK_MINUTE} if UP in [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}] | buy $${config.LIMIT_BUY_PRICE} both sides | TP $${config.TAKE_PROFIT_PRICE} | base size ${config.BASE_SHARES_PER_SIDE}/side | double size every ${config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD} consecutive losses`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
