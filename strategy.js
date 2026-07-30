// ============================================================
// strategy.js — the "brain". Two jobs:
//   1. modelProbabilityUp(): given current price, strike, time
//      left, and volatility, what's the true probability BTC
//      finishes above the strike? (Brownian motion, zero drift)
//   2. kellyStake(): given our edge vs the market's price, how
//      much of the bankroll should we risk?
// ============================================================

// Standard normal CDF via Abramowitz-Stegun approximation (no extra deps needed)
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) prob = 1 - prob;
  return prob;
}

// currentPrice, strikePrice: raw asset prices (e.g. BTC/USD)
// sigmaPerMinute: from binance.js
// minutesRemaining: time left in the window
function modelProbabilityUp(currentPrice, strikePrice, sigmaPerMinute, minutesRemaining) {
  if (minutesRemaining <= 0) return currentPrice > strikePrice ? 1 : 0;
  const sigmaT = sigmaPerMinute * Math.sqrt(minutesRemaining);
  if (sigmaT === 0) return currentPrice > strikePrice ? 1 : 0;
  const z = Math.log(currentPrice / strikePrice) / sigmaT;
  return normalCdf(z);
}

// Fractional Kelly stake for a binary token that costs `price` per share
// and pays $1 if it resolves YES, where our model says true prob is `trueProb`.
// Returns the fraction of bankroll to stake (0 if no edge or negative Kelly).
function kellyFraction(trueProb, price) {
  if (price <= 0 || price >= 1) return 0;
  const raw = trueProb - ((1 - trueProb) * price) / (1 - price);
  return Math.max(0, raw);
}

function decideTrade({ bankroll, upPrice, downPrice, modelProbUp, config }) {
  const modelProbDown = 1 - modelProbUp;
  const edgeUp = modelProbUp - upPrice;
  const edgeDown = modelProbDown - downPrice;

  let side, price, trueProb, edge;
  if (edgeUp >= edgeDown && edgeUp > 0) {
    side = 'UP';
    price = upPrice;
    trueProb = modelProbUp;
    edge = edgeUp;
  } else if (edgeDown > 0) {
    side = 'DOWN';
    price = downPrice;
    trueProb = modelProbDown;
    edge = edgeDown;
  } else {
    return null;
  }

  if (edge < config.MIN_EDGE_TO_TRADE) return null;

  const fullKelly = kellyFraction(trueProb, price);
  const fraction = Math.min(fullKelly * config.KELLY_FRACTION, config.MAX_POSITION_PCT_OF_BANKROLL);
  const stake = Math.round(bankroll * fraction * 100) / 100;

  if (stake < config.MIN_STAKE_DOLLARS) return null;

  return { side, price, trueProb, edge, stake };
}

module.exports = { modelProbabilityUp, kellyFraction, decideTrade, normalCdf };
