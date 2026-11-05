'use strict';

const FIRST_PHASE_INTERVAL_SECONDS = 3;
const FIRST_PHASE_END_SECONDS = 60;
const SECOND_PHASE_INTERVAL_SECONDS = 5;
const SECOND_PHASE_START_SECONDS = 70;
const SECOND_PHASE_END_SECONDS = 150;
const FIRST_PHASE_SHARES = 50;
const SECOND_PHASE_SHARES = 150;
const FIRST_PHASE_MAX_ASK = 0.40;
const SECOND_PHASE_MIN_ASK = 0.60;
const TAKER_ORDER_CHECKPOINTS = Object.freeze([
  ...Array.from({ length: FIRST_PHASE_END_SECONDS / FIRST_PHASE_INTERVAL_SECONDS }, (_, index) => ({
    slot: index,
    seconds: (index + 1) * FIRST_PHASE_INTERVAL_SECONDS,
    phase: 'FIRST',
    shares: FIRST_PHASE_SHARES,
  })),
  ...Array.from({
    length: (SECOND_PHASE_END_SECONDS - SECOND_PHASE_START_SECONDS) / SECOND_PHASE_INTERVAL_SECONDS + 1,
  }, (_, index) => ({
    slot: FIRST_PHASE_END_SECONDS / FIRST_PHASE_INTERVAL_SECONDS + index,
    seconds: SECOND_PHASE_START_SECONDS + index * SECOND_PHASE_INTERVAL_SECONDS,
    phase: 'SECOND',
    shares: SECOND_PHASE_SHARES,
  })),
]);

function scheduledOrderSlotAt(start, now) {
  if (!Number.isFinite(start) || !Number.isFinite(now)) return -1;
  const elapsedMs = now - start;
  if (elapsedMs < TAKER_ORDER_CHECKPOINTS[0].seconds * 1000) return -1;
  for (let index = 0; index < TAKER_ORDER_CHECKPOINTS.length; index++) {
    const checkpoint = TAKER_ORDER_CHECKPOINTS[index];
    const next = TAKER_ORDER_CHECKPOINTS[index + 1];
    const intervalSeconds = next
      ? next.seconds - checkpoint.seconds
      : SECOND_PHASE_INTERVAL_SECONDS;
    if (elapsedMs < (checkpoint.seconds + intervalSeconds) * 1000) return checkpoint.slot;
  }
  return -1;
}

function quoteIsFresh(quote, now, maxAgeMs) {
  return Number.isFinite(quote?.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= maxAgeMs;
}

function selectCheapestAskSide(quotes, now, maxAgeMs, tieBreakSide = 'UP') {
  const asks = {};
  const midpoints = {};
  for (const side of ['UP', 'DOWN']) {
    const quote = quotes?.[side];
    const ask = Number(quote?.bestAsk);
    const midpoint = Number(quote?.midpoint);
    if (!quoteIsFresh(quote, now, maxAgeMs)
      || !Number.isFinite(ask) || ask <= 0 || ask >= 1) {
      return { status: 'WAITING_FOR_FRESH_ASKS', cheapSide: null, expensiveSide: null, asks, midpoints };
    }
    asks[side] = ask;
    midpoints[side] = midpoint;
  }
  let cheapSide;
  let selectionReason = 'LOWER_BEST_ASK';
  if (Math.abs(asks.UP - asks.DOWN) > 1e-9) {
    cheapSide = asks.UP < asks.DOWN ? 'UP' : 'DOWN';
  } else if (Number.isFinite(midpoints.UP) && Number.isFinite(midpoints.DOWN)
    && Math.abs(midpoints.UP - midpoints.DOWN) > 1e-9) {
    cheapSide = midpoints.UP < midpoints.DOWN ? 'UP' : 'DOWN';
    selectionReason = 'LOWER_MIDPOINT_TIE_BREAK';
  } else {
    cheapSide = tieBreakSide === 'DOWN' ? 'DOWN' : 'UP';
    selectionReason = 'ALTERNATING_FULL_TIE_BREAK';
  }
  return {
    status: 'READY',
    cheapSide,
    expensiveSide: cheapSide === 'UP' ? 'DOWN' : 'UP',
    cheapestSide: cheapSide,
    otherSide: cheapSide === 'UP' ? 'DOWN' : 'UP',
    selectionReason,
    asks,
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

function filterAskLevelsForPhase(levels, phase) {
  const normalized = normalizeAskLevels(levels);
  return phase === 'SECOND'
    ? normalized.filter(level => level.price >= SECOND_PHASE_MIN_ASK)
    : normalized.filter(level => level.price <= FIRST_PHASE_MAX_ASK);
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

function simulateTakerBuy(asks, requestedShares, maxCost, estimateFee) {
  if (!Number.isFinite(requestedShares) || requestedShares <= 0
    || typeof estimateFee !== 'function') return null;

  const budget = Number.isFinite(maxCost) ? Math.max(0, maxCost) : Infinity;
  let remaining = requestedShares;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  const fills = [];

  for (const level of normalizeAskLevels(asks)) {
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
  FIRST_PHASE_INTERVAL_SECONDS,
  FIRST_PHASE_END_SECONDS,
  SECOND_PHASE_INTERVAL_SECONDS,
  SECOND_PHASE_START_SECONDS,
  SECOND_PHASE_END_SECONDS,
  FIRST_PHASE_SHARES,
  SECOND_PHASE_SHARES,
  FIRST_PHASE_MAX_ASK,
  SECOND_PHASE_MIN_ASK,
  TAKER_ORDER_CHECKPOINTS,
  scheduledOrderSlotAt,
  quoteIsFresh,
  selectCheapestAskSide,
  normalizeAskLevels,
  filterAskLevelsForPhase,
  simulateTakerBuy,
};
