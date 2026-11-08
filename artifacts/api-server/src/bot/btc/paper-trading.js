'use strict';

const WINDOW_MS = 5 * 60 * 1000;
const ENTRY_ORDER_LADDER = Object.freeze([
  Object.freeze({ limitPrice: 0.40, shares: 200 }),
  Object.freeze({ limitPrice: 0.30, shares: 100 }),
]);
const ENTRY_SHARES = ENTRY_ORDER_LADDER.reduce((sum, rung) => sum + rung.shares, 0);
const POLL_INTERVAL_MS = 500;
const MAX_QUOTE_AGE_MS = 5_000;
const DEFAULT_TAKER_FEE_RATE = 0.07;
const DEFAULT_TAKER_FEE_EXPONENT = 1;
const MARKET_LOOKAHEAD_MS = 10_000;

function quoteIsFresh(quote, now, maxAgeMs = MAX_QUOTE_AGE_MS) {
  return Number.isFinite(quote?.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= maxAgeMs;
}

function feeParameters(market, defaultRate = DEFAULT_TAKER_FEE_RATE) {
  const raw = market?.raw ?? market ?? {};
  const feesEnabled = raw.feesEnabled ?? raw.fees_enabled;
  if (feesEnabled === false || String(feesEnabled).toLowerCase() === 'false') {
    return { rate: 0, exponent: DEFAULT_TAKER_FEE_EXPONENT };
  }
  const schedule = raw.feeSchedule ?? raw.fee_schedule ?? raw.fees?.schedule ?? {};
  const rate = Number(schedule.rate ?? raw.takerFeeRate ?? raw.taker_fee_rate ?? defaultRate);
  const exponent = Number(schedule.exponent ?? raw.takerFeeExponent ?? raw.taker_fee_exponent
    ?? DEFAULT_TAKER_FEE_EXPONENT);
  return {
    rate: Number.isFinite(rate) && rate >= 0 ? rate : defaultRate,
    exponent: Number.isFinite(exponent) && exponent > 0 ? exponent : DEFAULT_TAKER_FEE_EXPONENT,
  };
}

function takerFeeAt(price, shares, parameters = {}) {
  const rate = Number(parameters.rate ?? DEFAULT_TAKER_FEE_RATE);
  const exponent = Number(parameters.exponent ?? DEFAULT_TAKER_FEE_EXPONENT);
  if (!Number.isFinite(price) || price <= 0 || price >= 1
    || !Number.isFinite(shares) || shares <= 0
    || !Number.isFinite(rate) || rate < 0
    || !Number.isFinite(exponent) || exponent <= 0) return 0;
  return rate * ((price * (1 - price)) ** exponent) * shares;
}

function estimateTakerFee(price, shares, market) {
  return takerFeeAt(price, shares, feeParameters(market));
}

function simulateTakerBuyFill(asks, requestedShares, market) {
  const requested = Number(requestedShares);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const parameters = feeParameters(market);
  const levels = (Array.isArray(asks) ? asks : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = requested;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 1e-8) break;
    const filledShares = Math.min(remaining, level.size);
    const filledCost = filledShares * level.price;
    const levelFees = takerFeeAt(level.price, filledShares, parameters);
    fills.push({ price: level.price, shares: filledShares, cost: filledCost, fees: levelFees });
    shares += filledShares;
    cost += filledCost;
    fees += levelFees;
    remaining -= filledShares;
  }
  if (shares <= 1e-8) return null;
  return {
    requestedShares: requested,
    shares,
    remainingShares: Math.max(0, remaining),
    averagePrice: cost / shares,
    cost,
    fees,
    totalCost: cost + fees,
    fills,
    feeRate: parameters.rate,
    feeExponent: parameters.exponent,
  };
}

function simulateLimitBuyFill(asks, limitPrice, requestedShares, market, {
  executionRole = 'MAKER',
  availableByPrice = null,
} = {}) {
  const limit = Number(limitPrice);
  const requested = Number(requestedShares);
  if (!Number.isFinite(limit) || limit <= 0 || limit >= 1
    || !Number.isFinite(requested) || requested <= 0) return null;
  const parameters = feeParameters(market);
  const levels = (Array.isArray(asks) ? asks : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price <= limit
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = requested;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 1e-8) break;
    const available = availableByPrice instanceof Map
      ? Number(availableByPrice.get(level.price) || 0)
      : level.size;
    const filledShares = Math.min(remaining, level.size, Math.max(0, available));
    if (filledShares <= 1e-8) continue;
    const fillPrice = executionRole === 'TAKER' ? level.price : limit;
    const filledCost = filledShares * fillPrice;
    const levelFees = executionRole === 'TAKER'
      ? takerFeeAt(fillPrice, filledShares, parameters) : 0;
    fills.push({ price: fillPrice, sourceAskPrice: level.price, shares: filledShares,
      cost: filledCost, fees: levelFees, executionRole });
    if (availableByPrice instanceof Map) {
      availableByPrice.set(level.price, Math.max(0, available - filledShares));
    }
    shares += filledShares;
    cost += filledCost;
    fees += levelFees;
    remaining -= filledShares;
  }
  if (shares <= 1e-8) return null;
  return {
    requestedShares: requested,
    shares,
    remainingShares: Math.max(0, remaining),
    averagePrice: cost / shares,
    cost,
    fees,
    totalCost: cost + fees,
    fills,
    feeRate: parameters.rate,
    feeExponent: parameters.exponent,
  };
}

function getWindowToScan(now) {
  const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const nextStart = currentStart + WINDOW_MS;
  return nextStart - now <= MARKET_LOOKAHEAD_MS ? nextStart : currentStart;
}

module.exports = {
  WINDOW_MS,
  ENTRY_ORDER_LADDER,
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
  MAX_QUOTE_AGE_MS,
  DEFAULT_TAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_EXPONENT,
  MARKET_LOOKAHEAD_MS,
  quoteIsFresh,
  feeParameters,
  takerFeeAt,
  estimateTakerFee,
  simulateTakerBuyFill,
  simulateLimitBuyFill,
  getWindowToScan,
};
