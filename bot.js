// ============================================================
// bot.js — the main loop. Every POLL_INTERVAL_SECONDS it:
//   1. finds the currently-live 15-min up/down market
//   2. if we have an open position whose window has ended,
//      resolves it by checking the token's own price convergence
//   3. if we have no open position and we're in the entry
//      window, evaluates the strategy and maybe opens one
// ============================================================

const config = require('./config');
const binance = require('./binance');
const polymarket = require('./polymarket');
const strategy = require('./strategy');
const { loadState, saveState } = require('./state');

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
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

  const fee = pos.stake * config.TAKER_FEE_RATE;
  let pnl;
  if (won) {
    const grossPayout = pos.stake / pos.price; // shares bought * $1 payout
    pnl = grossPayout - pos.stake - fee;
  } else {
    pnl = -pos.stake - fee;
  }

  state.bankroll = Math.round((state.bankroll + pnl) * 100) / 100;
  state.trades.push({
    ...pos,
    finalTokenPrice: tokenPrice,
    won,
    pnl: Math.round(pnl * 100) / 100,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });
  state.openPosition = null;

  log(`RESOLVED ${pos.side} | strike ${pos.strike} | token settled at ${tokenPrice.toFixed(3)} | ${won ? 'WIN' : 'LOSS'} | pnl ${pnl.toFixed(2)} | bankroll ${state.bankroll}`);
}

async function maybeEnterPosition(state) {
  const found = await polymarket.getCurrentUpDownMarket(config.ASSET, config.WINDOW_MINUTES);
  if (!found) {
    log('No live market found for current window yet.');
    return;
  }
  const { market, windowStart, windowEnd } = found;
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsRemaining = windowEnd - nowSec;

  // already have a position logged for this exact window? skip.
  if (state.openPosition && state.openPosition.windowStart === windowStart) return;

  if (
    secondsRemaining > config.ENTRY_WINDOW_SECONDS_MAX ||
    secondsRemaining < config.ENTRY_WINDOW_SECONDS_MIN
  ) {
    return; // not in our entry band yet
  }

  const { upTokenId, downTokenId } = polymarket.parseTokens(market);

  let strikeToUse;
  try {
    strikeToUse = await binance.getHistoricalPrice(config.ASSET, windowStart);
  } catch (e) {
    log(`WARNING: couldn't get historical strike for window ${windowStart} (${e.message}), skipping this check`);
    return; // don't fall back to currentPrice — that's the bug we just fixed
  }

  const [currentPrice, sigma, upPrice, downPrice] = await Promise.all([
    binance.getSpotPrice(config.ASSET),
    binance.getRealizedVolPerMinute(config.ASSET, config.VOL_LOOKBACK_MINUTES),
    polymarket.getMidpoint(upTokenId),
    polymarket.getMidpoint(downTokenId),
  ]);

  const minutesRemaining = secondsRemaining / 60;
  const modelProbUp = strategy.modelProbabilityUp(currentPrice, strikeToUse, sigma, minutesRemaining);

  const decision = strategy.decideTrade({
    bankroll: state.bankroll,
    upPrice,
    downPrice,
    modelProbUp,
    config,
  });

  log(
    `Checked window ${windowStart} | price ${currentPrice} strike ${strikeToUse} | modelUp ${(modelProbUp * 100).toFixed(1)}% marketUp ${(upPrice * 100).toFixed(1)}% | ${decision ? `TRADE ${decision.side} $${decision.stake}` : 'no edge, pass'}`
  );

  // Save what we saw this tick even if we didn't trade — this is what
  // lets the dashboard show a live "model vs market" view at all times,
  // not just when a position is open.
  state.lastCheck = {
    timestamp: new Date().toISOString(),
    windowStart,
    windowEnd,
    secondsRemaining,
    currentPrice,
    strike: strikeToUse,
    sigmaPerMinute: sigma,
    modelProbUp,
    upPrice,
    downPrice,
    tookTrade: !!decision,
  };

  if (!decision) return;

  state.openPosition = {
    windowStart,
    windowEnd,
    side: decision.side,
    tokenId: decision.side === 'UP' ? upTokenId : downTokenId,
    price: decision.price,
    trueProb: decision.trueProb,
    edge: decision.edge,
    stake: decision.stake,
    strike: strikeToUse,
    openedAt: new Date().toISOString(),
  };
}

async function tick() {
  const state = loadState();
  try {
    if (state.openPosition) {
      await resolveOpenPosition(state);
    }
    if (!state.openPosition) {
      await maybeEnterPosition(state);
    }
    state.lastError = null;
  } catch (e) {
    log('ERROR in tick:', e.message);
    state.lastError = e.message;
  }
  saveState(state);
}

function startBotLoop() {
  log(`Bot started. Demo mode: ${config.DEMO_MODE}. Starting bankroll: $${config.STARTING_BANKROLL}`);
  tick();
  setInterval(tick, config.POLL_INTERVAL_SECONDS * 1000);
}

module.exports = { startBotLoop, tick };
