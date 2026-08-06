// ============================================================
// bot.js — candle-pattern directional strategy, v10. NO hedge, NO
// dual-side dip-buy, NO ladder. Per window:
//   1. The moment a new window is detected, fetch the last
//      config.CANDLE_LOOKBACK CLOSED real BTC/ETH candles (Binance,
//      config.CANDLE_INTERVAL) and run them through
//      strategy.detectPattern() to get a Green/Red pattern + signal:
//      MOMENTUM_UP/DOWN, REVERSAL_UP/DOWN, CHOP, or NONE.
//   2. CHOP/NONE -> the window is SKIPPED entirely, no order on
//      either side.
//   3. A directional signal (UP or DOWN) -> if that side's live
//      Polymarket price is within [ENTRY_PRICE_MIN, ENTRY_PRICE_MAX],
//      place ONE resting limit buy at config.LIMIT_BUY_PRICE for
//      state.currentShareSize shares on ONLY that side. If the price
//      is outside that sanity range, the window is skipped instead.
//   4. Once filled, a take-profit sell rests at
//      config.TAKE_PROFIT_PRICE. If it fills before the window
//      closes, profit is locked. If not, the position rides naked to
//      the real window outcome (full win/loss).
//   5. Skipped windows (no position ever taken) do NOT affect the
//      consecutive-loss streak or share size — only TRADED windows
//      count. A traded window with net pnl < $0 is a loss; hitting a
//      fresh multiple of config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD
//      consecutive losses doubles state.currentShareSize going
//      forward. A winning traded window resets the streak to 0.
// ============================================================

const config = require('./config');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const candles = require('./binance');
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

// Fetches the recent candle pattern and returns a detectPattern()-shaped
// result. Never throws — on any fetch/parsing error it degrades to a
// NONE signal (skip the window) rather than trading blind.
async function getPatternSignal() {
  try {
    const recent = await candles.getRecentClosedCandles(config.ASSET, config.CANDLE_INTERVAL, config.CANDLE_LOOKBACK);
    const colors = strategy.colorsFromCandles(recent);
    const result = strategy.detectPattern(colors);
    log(`Candle pattern (${config.ASSET.toUpperCase()} ${config.CANDLE_INTERVAL}, last ${colors.length}): ${colors.join('') || '(none)'} -> pattern ${result.pattern || '(none)'} / signal ${result.signal}${result.side ? ' / side ' + result.side : ''}`);
    return result;
  } catch (e) {
    log('ERROR fetching candle pattern (skipping window):', e.message);
    return { pattern: null, signal: 'ERROR', side: null };
  }
}

// Pure status/fill-price bookkeeping for the single live position — no
// bankroll or pnl touched here. Resolution only happens once, at
// window close, in resolveWindow().
function processPosition(pos, ownPrice) {
  if (!pos) return;
  if (pos.status === 'order_pending') {
    if (ownPrice <= pos.orderPrice) {
      pos.fillPrice = pos.orderPrice;
      pos.fillFee = 0; // maker fill -> $0, per Polymarket's fee docs
      pos.fillRebate = estimateMakerRebate(pos.shares, pos.fillPrice);
      pos.filledAt = new Date().toISOString();
      pos.status = 'filled';
      log(`FILL ${pos.side} @ $${pos.fillPrice} (maker, $0 fee, est. rebate $${pos.fillRebate.toFixed(5)}) -> TP order resting @ $${pos.tpPrice}`);
    }
  } else if (pos.status === 'filled') {
    if (ownPrice >= pos.tpPrice) {
      pos.tpFillPrice = pos.tpPrice;
      pos.tpFillFee = 0; // maker fill -> $0
      pos.tpFillRebate = estimateMakerRebate(pos.shares, pos.tpFillPrice);
      pos.tpFilledAt = new Date().toISOString();
      pos.status = 'tp_filled';
      log(`TP FILLED ${pos.side} @ $${pos.tpFillPrice} (maker, $0 fee, est. rebate $${pos.tpFillRebate.toFixed(5)}) | locked $${((pos.tpFillPrice - pos.fillPrice) * pos.shares).toFixed(2)} profit on ${pos.shares} shares`);
    }
  }
}

// Attempts to resolve a closed window: checks the real outcome (no
// fallback — waits if still ambiguous), settles the single position
// (if any was taken), and updates the martingale streak. Returns true
// if resolved this call, false if still waiting on convergence.
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

  let cost = 0, payout = 0, fees = 0, rebates = 0;
  const pos = win.position;
  const traded = !!pos;

  if (pos) {
    if (pos.status === 'tp_filled') {
      const f = (pos.fillFee || 0) + (pos.tpFillFee || 0);
      const r = (pos.fillRebate || 0) + (pos.tpFillRebate || 0);
      cost = pos.shares * pos.fillPrice + f;
      payout = pos.shares * pos.tpFillPrice + r;
      fees += f;
      rebates += r;
    } else if (pos.status === 'filled') {
      const f = pos.fillFee || 0;
      const r = pos.fillRebate || 0;
      cost = pos.shares * pos.fillPrice + f;
      payout = (pos.side === wonSide ? pos.shares * 1 : 0) + r;
      pos.resolvedWon = pos.side === wonSide;
      pos.status = pos.resolvedWon ? 'resolved_win' : 'resolved_loss';
      fees += f;
      rebates += r;
    } else if (pos.status === 'order_pending') {
      cost = 0;
      payout = 0;
      pos.status = 'order_cancelled';
      pos.cancelledAt = new Date().toISOString();
    }
    pos.cost = Math.round(cost * 100000) / 100000;
    pos.payout = Math.round(payout * 100000) / 100000;
    pos.pnl = Math.round((payout - cost) * 100000) / 100000;
    pos.settledAt = new Date().toISOString();
  }

  const pnl = Math.round((payout - cost) * 100) / 100;
  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;

  // ---- Martingale: only TRADED windows affect the streak/size ----
  let isLoss = null;
  if (traded) {
    isLoss = pnl < 0;
    if (isLoss) {
      state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
      if (state.consecutiveLosses % config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD === 0) {
        const prevSize = state.currentShareSize;
        state.currentShareSize = state.currentShareSize * 2;
        log(`MARTINGALE: ${state.consecutiveLosses} consecutive losing TRADED windows -> doubling share size ${prevSize} -> ${state.currentShareSize}`);
      }
    } else {
      if (state.consecutiveLosses > 0) {
        log(`Loss streak broken at ${state.consecutiveLosses} (window pnl $${pnl.toFixed(2)} >= 0)`);
      }
      state.consecutiveLosses = 0;
    }
  }

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    pattern: win.pattern,
    signal: win.signal,
    side: win.side,
    traded,
    skipped: win.skipped,
    skipReason: win.skipReason,
    shareSize: win.shareSize,
    position: win.position,
    wonSide,
    totalFees: Math.round(fees * 100000) / 100000,
    totalRebates: Math.round(rebates * 100000) / 100000,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    isLoss,
    consecutiveLossesAfter: state.consecutiveLosses,
    shareSizeAfter: state.currentShareSize,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | pattern ${win.pattern || '(none)'} (${win.signal}) | ${traded ? `traded ${win.side}` : 'SKIPPED (' + win.skipReason + ')'} | fees $${fees.toFixed(5)} | est. rebates $${rebates.toFixed(5)} | pnl $${pnl.toFixed(2)} | ${traded ? (isLoss ? 'LOSS' : 'WIN') + ` (streak ${state.consecutiveLosses})` : 'no trade, streak unchanged'} | next share size ${state.currentShareSize} | bankroll $${state.bankroll}`
  );
  return true;
}

async function tick() {
  const state = loadState();
  const nowSec = Math.floor(Date.now() / 1000);

  if (state.currentShareSize == null) state.currentShareSize = config.BASE_SHARES;
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
        const patternResult = await getPatternSignal();

        state.currentWindow = {
          windowStart, windowEnd, upTokenId, downTokenId,
          shareSize,
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

      // First tick after a directional signal: check the sanity price
      // range and arm the single-side order (or skip if out of range).
      if (win.side && !win.position && !win.skipped) {
        const ownPrice = win.side === 'UP' ? upPrice : downPrice;
        if (ownPrice >= config.ENTRY_PRICE_MIN && ownPrice <= config.ENTRY_PRICE_MAX) {
          const tokenId = win.side === 'UP' ? upTokenId : downTokenId;
          win.position = strategy.buildPosition(windowStart, windowEnd, win.side, tokenId, win.shareSize, config);
          log(`ENTRY: pattern ${win.pattern} (${win.signal}) -> LIMIT buy ${win.side} @ $${config.LIMIT_BUY_PRICE}, ${win.shareSize} shares (price $${ownPrice.toFixed(2)} in sanity range [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}])`);
        } else {
          win.skipped = true;
          win.skipReason = `signaled ${win.side} but price $${ownPrice.toFixed(2)} outside sanity range [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}]`;
          log(`Window ${windowStart}: SKIPPED — ${win.skipReason}`);
        }
      }

      if (win.position) {
        const ownPrice = win.side === 'UP' ? upPrice : downPrice;
        processPosition(win.position, ownPrice);
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
  log(`Bot started (candle-pattern directional v10, no hedge). Bankroll: $${config.STARTING_BANKROLL} | candles ${config.ASSET.toUpperCase()} ${config.CANDLE_INTERVAL} x${config.CANDLE_LOOKBACK} | buy $${config.LIMIT_BUY_PRICE} signaled side only | TP $${config.TAKE_PROFIT_PRICE} | sanity range [${config.ENTRY_PRICE_MIN},${config.ENTRY_PRICE_MAX}] | base size ${config.BASE_SHARES} | double size every ${config.CONSECUTIVE_LOSS_DOUBLE_THRESHOLD} consecutive losing trades`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
