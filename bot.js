// ============================================================
// bot.js — ladder + counter-bet strategy, v8 (time-filtered entries
// + portfolio-level imbalance hedge). No new base positions in the
// first or last minute of a window (config.ENTRY_BLACKOUT_*); any
// base order still unfilled with under a minute left is cancelled
// outright. Separately, if a side that's bought unhedged base
// positions sees its OWN price fully reverse back down to
// config.IMBALANCE_HEDGE_TRIGGER_PRICE, the NET unhedged imbalance
// (not a fresh per-rung hedge) gets flattened in one combined taker
// trade — trading a small known cost for removing naked exposure
// once a breakout has clearly failed. Everything downstream —
// resolution, pnl — is unchanged. Every fill — whether it came from
// an original base rung, a per-rung counter, or a portfolio-level
// imbalance hedge — just accumulates into a running total of UP
// shares and DOWN shares held for that window. At window close, the
// whole accumulated position resolves ONCE against the real outcome:
//   payout = (winning side's total shares) × $1
//   pnl = payout − (total cost of everything bought that window)
// This naturally covers full hedges, partial hedges, imbalance
// hedges, and unhedged single fills with the same formula — no
// special casing needed.
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

// Pure status/fill-price bookkeeping — no bankroll or pnl touched here.
// Resolution only ever happens once, at window close, in resolveWindow().
// secondsIntoWindow / secondsRemaining gate entries at both ends of the
// window (see config.ENTRY_BLACKOUT_*) and unlock the fallback hedge
// once time is short (see config.FALLBACK_HEDGE_PRICE).
function processRungFill(rung, upPrice, downPrice, secondsIntoWindow, secondsRemaining) {
  const inEntryBlackout =
    secondsIntoWindow < config.ENTRY_BLACKOUT_START_SECONDS ||
    secondsRemaining < config.ENTRY_BLACKOUT_END_SECONDS;

  if (rung.status === 'waiting_base') {
    if (inEntryBlackout) return; // no new positions this close to open/close
    const ownPrice = rung.side === 'UP' ? upPrice : downPrice;
    // Confirm the breakout with a buffer before committing to an order —
    // only once price has moved BASE_ORDER_SLIPPAGE_CAP past the rung
    // (e.g. $0.62 for a $0.60 rung) do we treat this as a real breakout,
    // not just noise ticking through the level.
    if (ownPrice >= rung.rungPrice + config.BASE_ORDER_SLIPPAGE_CAP) {
      // Now rest a REAL limit order back at the original rung price —
      // since price is confirmed above it, this order is NOT marketable
      // at submission (it's a passive buy below current market), so
      // it's a genuine MAKER order: $0 fee, and it just waits for a
      // retest/pullback to $rungPrice to fill. If price never comes
      // back down, this rung simply never fills — a real, valid outcome.
      rung.baseOrderPrice = rung.rungPrice;
      rung.baseOrderPlacedAt = new Date().toISOString();
      rung.status = 'base_pending';
      log(`LIMIT order placed base ${rung.side} @ $${rung.baseOrderPrice} (breakout confirmed @ $${ownPrice.toFixed(2)}, resting for retest)`);
    }
  } else if (rung.status === 'base_pending') {
    if (secondsRemaining < config.ENTRY_BLACKOUT_END_SECONDS) {
      // Under a minute left and still unfilled — a fill now would have
      // no realistic chance of getting hedged, so pull the order instead
      // of letting it become naked risk with zero time to react.
      rung.status = 'base_cancelled';
      rung.cancelledAt = new Date().toISOString();
      log(`CANCELLED unfilled base order ${rung.side} @ $${rung.baseOrderPrice} (< ${config.ENTRY_BLACKOUT_END_SECONDS}s left in window)`);
      return;
    }
    const ownPrice = rung.side === 'UP' ? upPrice : downPrice;
    // Fills when price retraces back down to our resting order price —
    // a genuine maker match, same mechanic as the counter leg below.
    if (ownPrice <= rung.baseOrderPrice) {
      rung.baseFillPrice = rung.baseOrderPrice;
      rung.baseFillFee = 0; // maker fill -> $0, per Polymarket's fee docs
      rung.baseFillRebate = estimateMakerRebate(rung.shares, rung.baseFillPrice);
      rung.baseFilledAt = new Date().toISOString();
      rung.status = 'base_filled';
      rung.counterPrice = strategy.counterPriceFor(rung.baseFillPrice, config.LOCK_SPREAD);
      const counterSide = rung.side === 'UP' ? 'DOWN' : 'UP';
      log(`FILL base ${rung.side} @ $${rung.baseFillPrice} (maker, $0 fee, est. rebate $${rung.baseFillRebate.toFixed(5)}, retest confirmed) -> counter order ${counterSide} @ $${rung.counterPrice}`);
    }
    // else: order still resting unfilled — keep checking each tick.
  } else if (rung.status === 'base_filled') {
    const oppPrice = rung.side === 'UP' ? downPrice : upPrice;
    if (oppPrice <= rung.counterPrice) {
      rung.counterFillPrice = rung.counterPrice;
      rung.counterFillFee = 0; // maker fill -> $0
      rung.counterFillRebate = estimateMakerRebate(rung.shares, rung.counterFillPrice);
      rung.counterFilledAt = new Date().toISOString();
      rung.status = 'counter_filled';
      log(`COUNTER FILLED ${rung.side}-rung @ $${rung.counterFillPrice} (maker, $0 fee, est. rebate $${rung.counterFillRebate.toFixed(5)}) | now holding both legs, awaiting window resolution`);
    }
    // else: still waiting on the ideal counter price. If this side's own
    // price fully reverses instead, processImbalanceHedge (below) handles
    // it at the portfolio level rather than per-rung.
  }
}

// Portfolio-level stop-hedge: runs once per tick, AFTER all per-rung
// processing, across the whole current window. Triggers when a side that
// has unhedged base fills (status === 'base_filled', ideal counter not
// yet reached) sees its OWN price fully reverse back down to
// config.IMBALANCE_HEDGE_TRIGGER_PRICE — i.e. the breakout has clearly
// failed. Hedges ONLY the net imbalance (unhedged shares on that side
// minus unhedged shares already offset by the other side's own unhedged
// fills, if any) in ONE combined trade, not a fresh per-rung hedge. This
// is urgent de-risking once the move has reversed, so it's a real TAKER
// order — pays BASE_TAKER_FEE_RATE, no maker rebate — for certainty of
// execution instead of hoping a passive order fills before price moves
// further.
function processImbalanceHedge(win, upPrice, downPrice) {
  const unhedgedUpRungs = win.rungs.filter(r => r.status === 'base_filled' && r.side === 'UP');
  const unhedgedDownRungs = win.rungs.filter(r => r.status === 'base_filled' && r.side === 'DOWN');
  const unhedgedUp = unhedgedUpRungs.reduce((a, r) => a + r.shares, 0);
  const unhedgedDown = unhedgedDownRungs.reduce((a, r) => a + r.shares, 0);
  const netImbalance = unhedgedUp - unhedgedDown;

  if (netImbalance > 0 && upPrice <= config.IMBALANCE_HEDGE_TRIGGER_PRICE) {
    // UP was bought as base and has fully reversed -> flatten with DOWN
    const hedgeShares = netImbalance;
    const hedgePrice = downPrice;
    const fee = Math.round(hedgeShares * config.BASE_TAKER_FEE_RATE * hedgePrice * (1 - hedgePrice) * 100000) / 100000;
    if (!win.imbalanceHedges) win.imbalanceHedges = [];
    win.imbalanceHedges.push({
      side: 'DOWN', shares: hedgeShares, price: hedgePrice, fee, rebate: 0,
      filledAt: new Date().toISOString(),
      reason: `UP retraced to $${upPrice.toFixed(2)} (<= $${config.IMBALANCE_HEDGE_TRIGGER_PRICE}), flattened ${hedgeShares} unhedged UP shares`,
    });
    for (const r of unhedgedUpRungs) { r.status = 'imbalance_hedged'; r.cancelledAt = new Date().toISOString(); }
    log(`IMBALANCE HEDGE: UP retraced to $${upPrice.toFixed(2)} -> bought ${hedgeShares} DOWN @ $${hedgePrice.toFixed(2)} (taker, fee $${fee.toFixed(5)}) to flatten net imbalance`);
  } else if (netImbalance < 0 && downPrice <= config.IMBALANCE_HEDGE_TRIGGER_PRICE) {
    const hedgeShares = -netImbalance;
    const hedgePrice = upPrice;
    const fee = Math.round(hedgeShares * config.BASE_TAKER_FEE_RATE * hedgePrice * (1 - hedgePrice) * 100000) / 100000;
    if (!win.imbalanceHedges) win.imbalanceHedges = [];
    win.imbalanceHedges.push({
      side: 'UP', shares: hedgeShares, price: hedgePrice, fee, rebate: 0,
      filledAt: new Date().toISOString(),
      reason: `DOWN retraced to $${downPrice.toFixed(2)} (<= $${config.IMBALANCE_HEDGE_TRIGGER_PRICE}), flattened ${hedgeShares} unhedged DOWN shares`,
    });
    for (const r of unhedgedDownRungs) { r.status = 'imbalance_hedged'; r.cancelledAt = new Date().toISOString(); }
    log(`IMBALANCE HEDGE: DOWN retraced to $${downPrice.toFixed(2)} -> bought ${hedgeShares} UP @ $${hedgePrice.toFixed(2)} (taker, fee $${fee.toFixed(5)}) to flatten net imbalance`);
  }
  // else: no imbalance, or neither side has reversed far enough — nothing to do.
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

  let totalUpShares = 0, totalUpCost = 0, totalDownShares = 0, totalDownCost = 0, totalFees = 0, totalRebates = 0;
  for (const rung of win.rungs) {
    if (rung.baseFillPrice !== null) {
      const fee = rung.baseFillFee || 0;
      const rebate = rung.baseFillRebate || 0;
      totalFees += fee;
      totalRebates += rebate;
      if (rung.side === 'UP') { totalUpShares += rung.shares; totalUpCost += rung.shares * rung.baseFillPrice + fee - rebate; }
      else { totalDownShares += rung.shares; totalDownCost += rung.shares * rung.baseFillPrice + fee - rebate; }
    }
    if (rung.counterFillPrice !== null) {
      // the counter leg is always on the OPPOSITE token from rung.side
      // maker fill -> $0 fee (rung.counterFillFee is always 0, kept for
      // symmetry/auditability rather than assumed)
      const fee = rung.counterFillFee || 0;
      const rebate = rung.counterFillRebate || 0;
      totalFees += fee;
      totalRebates += rebate;
      if (rung.side === 'UP') { totalDownShares += rung.shares; totalDownCost += rung.shares * rung.counterFillPrice + fee - rebate; }
      else { totalUpShares += rung.shares; totalUpCost += rung.shares * rung.counterFillPrice + fee - rebate; }
    }
  }

  // Portfolio-level imbalance hedges (see processImbalanceHedge) — one
  // combined trade per trigger, not tied to a single rung.
  for (const hedge of win.imbalanceHedges || []) {
    totalFees += hedge.fee;
    totalRebates += hedge.rebate;
    if (hedge.side === 'UP') { totalUpShares += hedge.shares; totalUpCost += hedge.shares * hedge.price + hedge.fee - hedge.rebate; }
    else { totalDownShares += hedge.shares; totalDownCost += hedge.shares * hedge.price + hedge.fee - hedge.rebate; }
  }

  const payout = wonSide === 'UP' ? totalUpShares * 1 : totalDownShares * 1;
  const cost = totalUpCost + totalDownCost;
  const pnl = Math.round((payout - cost) * 100) / 100;

  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;

  state.windowHistory.push({
    windowStart: win.windowStart,
    windowEnd: win.windowEnd,
    rungs: win.rungs,
    imbalanceHedges: win.imbalanceHedges || [],
    wonSide,
    totalUpShares,
    totalUpCost: Math.round(totalUpCost * 100) / 100,
    totalDownShares,
    totalDownCost: Math.round(totalDownCost * 100) / 100,
    totalFees: Math.round(totalFees * 100000) / 100000,
    totalRebates: Math.round(totalRebates * 100000) / 100000,
    payout: Math.round(payout * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    pnl,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });

  log(
    `WINDOW ${win.windowStart} RESOLVED: ${wonSide} won | UP ${totalUpShares}sh/$${totalUpCost.toFixed(2)} | DOWN ${totalDownShares}sh/$${totalDownCost.toFixed(2)} | fees $${totalFees.toFixed(5)} | est. rebates $${totalRebates.toFixed(5)} | payout $${payout.toFixed(2)} | pnl $${pnl.toFixed(2)} | bankroll $${state.bankroll}`
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
        processRungFill(rung, upPrice, downPrice, nowSec - windowStart, windowEnd - nowSec);
      }
      processImbalanceHedge(state.currentWindow, upPrice, downPrice);
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
  log(`Bot started (ladder v8/time-filtered + imbalance hedge, aggregate resolution). Bankroll: $${config.STARTING_BANKROLL} | Rungs: ${config.RUNG_PRICES.join('/')} | ${config.SHARES_PER_RUNG} shares/rung | counter spread $${config.LOCK_SPREAD} | breakout confirm buffer $${config.BASE_ORDER_SLIPPAGE_CAP} | entry blackout ${config.ENTRY_BLACKOUT_START_SECONDS}s/${config.ENTRY_BLACKOUT_END_SECONDS}s | imbalance hedge trigger $${config.IMBALANCE_HEDGE_TRIGGER_PRICE}`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_MS);
}

module.exports = { startBotLoop, tick };
