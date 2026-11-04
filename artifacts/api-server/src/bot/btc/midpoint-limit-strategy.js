'use strict';

const ORDER_INTERVAL_SECONDS = 20;
const CHEAP_PHASE_END_SECONDS = 120;
const EXPENSIVE_PHASE_START_SECONDS = 140;
const EXPENSIVE_PHASE_END_SECONDS = 240;
const CHEAP_ORDER_SHARES = 100;
const EXPENSIVE_ORDER_SHARES = 300;
const LIMIT_ORDER_CHECKPOINTS = Object.freeze([
  ...Array.from({ length: 6 }, (_, index) => ({
    slot: index,
    seconds: (index + 1) * ORDER_INTERVAL_SECONDS,
    phase: 'CHEAP',
    shares: CHEAP_ORDER_SHARES,
  })),
  ...Array.from({ length: 6 }, (_, index) => ({
    slot: index + 6,
    seconds: EXPENSIVE_PHASE_START_SECONDS + index * ORDER_INTERVAL_SECONDS,
    phase: 'EXPENSIVE',
    shares: EXPENSIVE_ORDER_SHARES,
  })),
]);

function scheduledOrderSlotAt(start, now) {
  if (!Number.isFinite(start) || !Number.isFinite(now)) return -1;
  const elapsedMs = now - start;
  const firstOrderAt = ORDER_INTERVAL_SECONDS * 1000;
  const scheduleEnd = (EXPENSIVE_PHASE_END_SECONDS + ORDER_INTERVAL_SECONDS) * 1000;
  if (elapsedMs < firstOrderAt || elapsedMs >= scheduleEnd) return -1;
  return Math.floor((elapsedMs - firstOrderAt) / (ORDER_INTERVAL_SECONDS * 1000));
}

function quoteIsFresh(quote, now, maxAgeMs) {
  return Number.isFinite(quote?.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= maxAgeMs;
}

function selectMidpointSides(quotes, now, maxAgeMs) {
  const midpoints = {};
  for (const side of ['UP', 'DOWN']) {
    const quote = quotes?.[side];
    const midpoint = Number(quote?.midpoint);
    if (!quoteIsFresh(quote, now, maxAgeMs)
      || !Number.isFinite(midpoint) || midpoint <= 0 || midpoint >= 1) {
      return { status: 'WAITING_FOR_FRESH_MIDPOINTS', cheapSide: null, expensiveSide: null, midpoints };
    }
    midpoints[side] = midpoint;
  }
  if (Math.abs(midpoints.UP - midpoints.DOWN) < 1e-9) {
    return { status: 'MIDPOINTS_TIED', cheapSide: null, expensiveSide: null, midpoints };
  }
  const cheapSide = midpoints.UP < midpoints.DOWN ? 'UP' : 'DOWN';
  return {
    status: 'READY',
    cheapSide,
    expensiveSide: cheapSide === 'UP' ? 'DOWN' : 'UP',
    midpoints,
  };
}

function normalizeAskLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function affordableShares(price, requestedShares, budget, estimateFee) {
  if (!Number.isFinite(budget)) return requestedShares;
  const fullCost = price * requestedShares + estimateFee(price, requestedShares);
  if (fullCost <= budget + 1e-9) return requestedShares;
  let low = 0;
  let high = requestedShares;
  for (let attempt = 0; attempt < 48; attempt++) {
    const middle = (low + high) / 2;
    const total = price * middle + estimateFee(price, middle);
    if (total <= budget + 1e-9) low = middle;
    else high = middle;
  }
  return low;
}

function simulateLimitBuy(asks, limitPrice, requestedShares, maxCost, estimateFee) {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1
    || !Number.isFinite(requestedShares) || requestedShares <= 0
    || typeof estimateFee !== 'function') return null;

  const budget = Number.isFinite(maxCost) ? Math.max(0, maxCost) : Infinity;
  let remaining = requestedShares;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  const fills = [];

  for (const level of normalizeAskLevels(asks)) {
    if (level.price > limitPrice + 1e-9) break;
    const requestedAtLevel = Math.min(remaining, level.size);
    const fillShares = affordableShares(level.price, requestedAtLevel,
      budget - cost - fees, estimateFee);
    if (fillShares <= 1e-8) break;

    const fillCost = fillShares * level.price;
    const fillFees = estimateFee(level.price, fillShares);
    fills.push({ price: level.price, shares: fillShares });
    shares += fillShares;
    cost += fillCost;
    fees += fillFees;
    remaining -= fillShares;
    if (remaining <= 1e-8) break;
  }

  if (shares <= 1e-8) return null;
  return {
    shares,
    remainingShares: Math.max(0, requestedShares - shares),
    averagePrice: cost / shares,
    cost,
    fees,
    totalCost: cost + fees,
    fills,
  };
}

module.exports = {
  ORDER_INTERVAL_SECONDS,
  CHEAP_PHASE_END_SECONDS,
  EXPENSIVE_PHASE_START_SECONDS,
  EXPENSIVE_PHASE_END_SECONDS,
  CHEAP_ORDER_SHARES,
  EXPENSIVE_ORDER_SHARES,
  LIMIT_ORDER_CHECKPOINTS,
  scheduledOrderSlotAt,
  quoteIsFresh,
  selectMidpointSides,
  normalizeAskLevels,
  simulateLimitBuy,
};
