// ============================================================
// bot.js — the main loop. Every POLL_INTERVAL_SECONDS it:
//   1. takes a fresh snapshot of the live market — price, strike,
//      model probability, and both token prices — UNCONDITIONALLY,
//      whether or not a trade is open or we're near entry. This is
//      what the dashboard shows as "live."
//   2. if we have an open position whose window has ended, resolves
//      it by checking the token's own price convergence
//   3. if we have no open position and we're in the entry window,
//      evaluates the strategy against that same snapshot and maybe
//      opens a trade
// ============================================================

const config = require('./config');
const binance = require('./binance');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// In-memory caches (don't need to survive restarts — a cold cache just
// refetches once). Strike only needs fetching once per window; volatility
// changes slowly enough that recomputing it every 2s tick would just be
// wasted load on Coinbase's candles endpoint for no real benefit.
let strikeCache = null; // { windowStart, strike }
let volCache = null; // { sigma, computedAtMs }

// Always runs, every tick, regardless of open position or entry timing.
// This is the single source of truth for "what does the market look like
// right now" — both for the dashboard and for trade decisions.
async function takeLiveSnapshot(state) {
  const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);
  if (!found) {
    log('No live market found for current window yet.');
    return null;
  }
  const { market, windowStart, windowEnd } = found;
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsRemaining = windowEnd - nowSec;

  const { upTokenId, downTokenId } = polymarket.parseTokens(market);

  let strikeToUse;
  if (strikeCache && strikeCache.windowStart === windowStart) {
    strikeToUse = strikeCache.strike;
  } else {
    try {
      strikeToUse = await binance.getHistoricalPrice(config.ASSET, windowStart);
      strikeCache = { windowStart, strike: strikeToUse };
    } catch (e) {
      log(`WARNING: couldn't get historical strike for window ${windowStart} (${e.message})`);
      return null; // no fallback — skip this tick's snapshot entirely
    }
  }

  const nowMs = Date.now();
  let sigmaRaw;
  if (volCache && nowMs - volCache.computedAtMs < config.VOL_RECOMPUTE_INTERVAL_SECONDS * 1000) {
    sigmaRaw = volCache.sigma;
  } else {
    sigmaRaw = await binance.getRealizedVolPerMinute(config.ASSET, config.VOL_LOOKBACK_MINUTES);
    volCache = { sigma: sigmaRaw, computedAtMs: nowMs };
  }

  const [currentPrice, upPrice, downPrice] = await Promise.all([
    binance.getSpotPrice(config.ASSET),
    polymarket.getMidpoint(upTokenId),
    polymarket.getMidpoint(downTokenId),
  ]);

  const lowVolRegime = sigmaRaw < config.MIN_SIGMA_PER_MINUTE;
  const sigma = Math.max(sigmaRaw, config.MIN_SIGMA_PER_MINUTE);

  const minutesRemaining = secondsRemaining / 60;
  const modelProbUp = strategy.modelProbabilityUp(currentPrice, strikeToUse, sigma, minutesRemaining);

  const snapshot = {
    timestamp: new Date().toISOString(),
    market, windowStart, windowEnd, secondsRemaining,
    upTokenId, downTokenId,
    currentPrice, strike: strikeToUse, sigmaPerMinute: sigma, sigmaRaw, lowVolRegime,
    modelProbUp, upPrice, downPrice,
  };

  // This is what makes the dashboard genuinely live: updated every single
  // tick, independent of whether we're trading or waiting.
  state.lastCheck = {
    timestamp: snapshot.timestamp,
    windowStart, windowEnd, secondsRemaining,
    currentPrice, strike: strikeToUse, sigmaPerMinute: sigma, lowVolRegime,
    modelProbUp, upPrice, downPrice,
    tookTrade: false, // maybeEnterPosition overwrites this to true if it trades
  };

  return snapshot;
}

async function resolveOpenPosition(state) {
  const pos = state.openPosition;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < pos.windowEnd) return; // window hasn't closed yet

  // Resolution rule: check the price of the token we actually hold. Once
  // the window closes, Polymarket's own market converges the winning
  // side's price toward $1.00 and the losing side's toward $0.00. We wait
  // for that convergence rather than guessing from an external feed — if
  // it's still ambiguous (between the thresholds), we just check again
  // next tick. No fallback, no guessing.
  let tokenPrice;
  try {
    tokenPrice = await polymarket.getMidpoint(pos.tokenId);
  } catch (e) {
    log('ERROR fetching token price to resolve position:', e.message);
    return; // try again next tick
  }

  let won;
  if (tokenPrice >= config.RESOLUTION_WIN_THRESHOLD) {
    won = true;
  } else if (tokenPrice <= config.RESOLUTION_LOSS_THRESHOLD) {
    won = false;
  } else {
    log(`Window ${pos.windowStart} closed but ${pos.side} token price (${tokenPrice.toFixed(3)}) hasn't converged yet — waiting.`);
    return; // still settling, check again next tick
  }

  // Real Polymarket taker fee: fee = shares × rate × price × (1-price).
  // For our fixed-dollar stake (shares = stake/price), that simplifies to
  // fee = stake × rate × (1-price) — NOT a flat percentage of stake.
  // Cheaper/longshot entries cost proportionally more in fees.
  const fee = pos.stake * config.TAKER_FEE_RATE * (1 - pos.price);
  let pnl, grossPayout;
  if (won) {
    grossPayout = pos.stake / pos.price; // shares bought * $1 payout
    pnl = grossPayout - pos.stake - fee;
  } else {
    grossPayout = 0;
    pnl = -pos.stake - fee;
  }

  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;
  state.trades.push({
    ...pos,
    finalTokenPrice: tokenPrice,
    grossPayout: Math.round(grossPayout * 100) / 100,
    fee: Math.round(fee * 100) / 100,
    won,
    pnl: Math.round(pnl * 100) / 100,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });
  state.openPosition = null;

  log(`RESOLVED ${pos.side} | strike ${pos.strike} | token settled at ${tokenPrice.toFixed(3)} | ${won ? 'WIN' : 'LOSS'} | pnl ${pnl.toFixed(2)} | bankroll ${state.bankroll}`);
}

async function maybeEnterPosition(state, snapshot) {
  if (!snapshot) return;
  const { windowStart, windowEnd, secondsRemaining, upTokenId, downTokenId, upPrice, downPrice, modelProbUp, strike } = snapshot;

  // already recorded a shadow/real observation for this exact window? skip.
  if (state.pendingShadow && state.pendingShadow.windowStart === windowStart) return;
  if (state.openPosition && state.openPosition.windowStart === windowStart) return;

  if (
    secondsRemaining > config.ENTRY_WINDOW_SECONDS_MAX ||
    secondsRemaining < config.ENTRY_WINDOW_SECONDS_MIN
  ) {
    return; // not in our entry band yet — snapshot was still recorded for the dashboard
  }

  const decision = strategy.decideTrade({
    bankroll: state.bankroll,
    upPrice,
    downPrice,
    modelProbUp,
    config,
  });

  log(
    `Checked window ${windowStart} | price ${snapshot.currentPrice} strike ${strike} | modelUp ${(modelProbUp * 100).toFixed(1)}% marketUp ${(upPrice * 100).toFixed(1)}% | ${decision ? `${config.TRADING_ENABLED ? 'TRADE' : 'WOULD-TRADE (shadow only)'} ${decision.side} $${decision.stake}` : 'no edge, pass'}`
  );

  // SHADOW_MODE: record every window we evaluated, regardless of whether
  // an edge cleared the threshold, so we can check afterward whether
  // "model disagrees with market" actually predicts anything — without
  // staking a cent while we find out.
  if (config.SHADOW_MODE) {
    state.pendingShadow = {
      windowStart, windowEnd,
      upTokenId, downTokenId,
      modelProbUp, upPrice, downPrice,
      marketFavoredSide: upPrice > downPrice ? 'UP' : 'DOWN',
      modelFavoredSide: modelProbUp > 0.5 ? 'UP' : 'DOWN',
      wouldTradeSide: decision ? decision.side : null,
      wouldTradeEdge: decision ? decision.edge : null,
      lowVolRegime: snapshot.lowVolRegime,
      capturedAt: new Date().toISOString(),
    };
  }

  if (!decision) return;
  if (!config.TRADING_ENABLED) return; // shadow-only: log what we would have done, but don't stake

  state.lastCheck.tookTrade = true;

  state.openPosition = {
    windowStart,
    windowEnd,
    side: decision.side,
    tokenId: decision.side === 'UP' ? upTokenId : downTokenId,
    price: decision.price,
    trueProb: decision.trueProb,
    edge: decision.edge,
    stake: decision.stake,
    strike,
    modelProbUpAtEntry: modelProbUp,
    upPriceAtEntry: upPrice,
    downPriceAtEntry: downPrice,
    lowVolRegime: snapshot.lowVolRegime,
    openedAt: new Date().toISOString(),
  };
}

// Resolves the pending shadow observation once its window has closed, by
// checking real token price convergence — same no-fallback rule as real
// position resolution. Updates running accuracy counters so we can see,
// live, whether the model or the market is the better predictor, and
// specifically whether "would-trade" disagreement calls are actually
// profitable before ever staking demo money on them again.
async function resolveShadow(state) {
  const shadow = state.pendingShadow;
  if (!shadow) return;
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < shadow.windowEnd) return;

  let upTokenPrice;
  try {
    upTokenPrice = await polymarket.getMidpoint(shadow.upTokenId);
  } catch (e) {
    log('ERROR fetching shadow resolution price:', e.message);
    return;
  }

  let actualWinner;
  if (upTokenPrice >= config.RESOLUTION_WIN_THRESHOLD) actualWinner = 'UP';
  else if (upTokenPrice <= config.RESOLUTION_LOSS_THRESHOLD) actualWinner = 'DOWN';
  else {
    log(`Shadow window ${shadow.windowStart} not converged yet (up token ${upTokenPrice.toFixed(3)}) — waiting.`);
    return;
  }

  if (!state.shadowStats) {
    state.shadowStats = {
      totalWindows: 0,
      modelCorrect: 0,
      marketCorrect: 0,
      disagreementCount: 0,
      modelCorrectOnDisagreement: 0,
      wouldTradeCount: 0,
      wouldTradeWins: 0,
    };
  }
  const stats = state.shadowStats;
  stats.totalWindows++;
  if (shadow.modelFavoredSide === actualWinner) stats.modelCorrect++;
  if (shadow.marketFavoredSide === actualWinner) stats.marketCorrect++;
  if (shadow.modelFavoredSide !== shadow.marketFavoredSide) {
    stats.disagreementCount++;
    if (shadow.modelFavoredSide === actualWinner) stats.modelCorrectOnDisagreement++;
  }
  if (shadow.wouldTradeSide) {
    stats.wouldTradeCount++;
    if (shadow.wouldTradeSide === actualWinner) stats.wouldTradeWins++;
  }

  log(`SHADOW RESOLVED window ${shadow.windowStart} | actual ${actualWinner} | model said ${shadow.modelFavoredSide} (${shadow.modelFavoredSide===actualWinner?'correct':'wrong'}) | market said ${shadow.marketFavoredSide} (${shadow.marketFavoredSide===actualWinner?'correct':'wrong'}) | running: model ${stats.modelCorrect}/${stats.totalWindows}, market ${stats.marketCorrect}/${stats.totalWindows}, would-trade ${stats.wouldTradeWins}/${stats.wouldTradeCount}`);

  state.pendingShadow = null;
}

async function tick() {
  const state = loadState();

  let snapshot = null;
  try {
    snapshot = await takeLiveSnapshot(state);
  } catch (e) {
    log('ERROR taking live snapshot:', e.message);
    state.lastError = e.message;
  }

  try {
    if (state.pendingShadow) {
      await resolveShadow(state);
    }
  } catch (e) {
    log('ERROR resolving shadow:', e.message);
    state.lastError = e.message;
  }

  try {
    if (state.openPosition) {
      await resolveOpenPosition(state);
    }
    if (!state.openPosition) {
      await maybeEnterPosition(state, snapshot);
    }
    if (!state.lastError) state.lastError = null;
  } catch (e) {
    log('ERROR in tick:', e.message);
    state.lastError = e.message;
  }
  saveState(state);
}

function startBotLoop() {
  log(`Bot started. Trading enabled: ${config.TRADING_ENABLED} | Shadow mode: ${config.SHADOW_MODE} | Bankroll: $${config.STARTING_BANKROLL}`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_SECONDS * 1000);
}

module.exports = { startBotLoop, tick };
