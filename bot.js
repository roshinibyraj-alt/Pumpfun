// ============================================================
// bot.js — the main loop. Every POLL_INTERVAL_SECONDS it:
//   1. finds the currently-live 15-min up/down market
//   2. if we have an open position whose window has ended,
//      resolves it (win/loss) and updates the bankroll
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

  let finalPrice;
  try {
    finalPrice = await binance.getSpotPrice(config.ASSET);
  } catch (e) {
    log('ERROR fetching final price to resolve position:', e.message);
    return; // try again next tick
  }

  // Approximation of Polymarket's official resolution: compares the
  // close-of-window price to the recorded strike. Polymarket itself
  // resolves against a Chainlink price feed, which can differ from
  // Binance spot by a tiny amount — expect occasional near-strike
  // resolution mismatches in demo mode.
  const wentUp = finalPrice > pos.strike;
  const won = (pos.side === 'UP' && wentUp) || (pos.side === 'DOWN' && !wentUp);

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
    finalPrice,
    won,
    pnl: Math.round(pnl * 100) / 100,
    bankrollAfter: state.bankroll,
    resolvedAt: new Date().toISOString(),
  });
  state.openPosition = null;

  log(`RESOLVED ${pos.side} | strike ${pos.strike} -> final ${finalPrice} | ${won ? 'WIN' : 'LOSS'} | pnl ${pnl.toFixed(2)} | bankroll ${state.bankroll}`);
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

  const strike = parseFloat(market.strikePrice || market.startPrice || 0);
  const { upTokenId, downTokenId } = polymarket.parseTokens(market);

  const [currentPrice, sigma, upPrice, downPrice] = await Promise.all([
    binance.getSpotPrice(config.ASSET),
    binance.getRealizedVolPerMinute(config.ASSET, config.VOL_LOOKBACK_MINUTES),
    polymarket.getMidpoint(upTokenId),
    polymarket.getMidpoint(downTokenId),
  ]);

  const strikeToUse = strike > 0 ? strike : currentPrice; // fallback if field missing
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

  if (!decision) return;

  state.openPosition = {
    windowStart,
    windowEnd,
    side: decision.side,
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
