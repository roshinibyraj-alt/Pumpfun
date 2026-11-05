'use strict';

const ENTRY_TRIGGER_SECONDS = 120;
const ENTRY_TRIGGER_PRICE = 0.80;
const STRATEGY_VERSION = 'btc-midpoint-ladder-maker-v2';
const LIMIT_ORDER_LADDER = Object.freeze([
  Object.freeze({ slot: 0, price: 0.40, shares: 1000 }),
  Object.freeze({ slot: 1, price: 0.60, shares: 2000 }),
]);

function quoteIsFresh(quote, now, maxAgeMs) {
  return Number.isFinite(quote?.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= maxAgeMs;
}

function selectTriggeredSide(quotes, now, maxAgeMs, triggerPrice = ENTRY_TRIGGER_PRICE) {
  const prices = {};
  for (const side of ['UP', 'DOWN']) {
    const quote = quotes?.[side];
    const midpoint = Number(quote?.midpoint);
    if (quoteIsFresh(quote, now, maxAgeMs)
      && Number.isFinite(midpoint) && midpoint > 0 && midpoint < 1) {
      prices[side] = midpoint;
    }
  }

  const candidates = ['UP', 'DOWN']
    .filter(side => Number.isFinite(prices[side]) && prices[side] >= triggerPrice)
    .sort((a, b) => prices[b] - prices[a] || (a === 'UP' ? -1 : 1));

  if (!candidates.length) {
    return {
      status: 'WAITING_FOR_TRIGGER',
      selectedSide: null,
      triggerPrice,
      prices,
    };
  }

  const selectedSide = candidates[0];
  return {
    status: 'READY',
    selectedSide,
    triggerPrice,
    triggeringPrice: prices[selectedSide],
    prices,
    selectionReason: candidates.length > 1 ? 'HIGHEST_QUALIFYING_MIDPOINT' : 'MIDPOINT_TRIGGER',
  };
}

function normalizeAskLevels(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
}

function filterAskLevelsForLimit(levels, limitPrice) {
  if (!Number.isFinite(limitPrice) || limitPrice <= 0 || limitPrice >= 1) return [];
  return normalizeAskLevels(levels).filter(level => level.price === limitPrice);
}

function simulateLimitBuyFill(levels, limitPrice, requestedShares, feeRate = 0.07) {
  if (!Number.isFinite(requestedShares) || requestedShares <= 0
    || !Number.isFinite(feeRate) || feeRate < 0) return null;
  const fills = [];
  let remainingShares = requestedShares;
  let shares = 0;
  let cost = 0;
  let rebateFeeEquivalent = 0;
  for (const level of filterAskLevelsForLimit(levels, limitPrice)) {
    const fillShares = Math.min(remainingShares, level.size);
    if (fillShares <= 1e-8) continue;
    const fillCost = fillShares * level.price;
    fills.push({ price: level.price, shares: fillShares });
    shares += fillShares;
    cost += fillCost;
    rebateFeeEquivalent += fillShares * feeRate * level.price * (1 - level.price);
    remainingShares -= fillShares;
    if (remainingShares <= 1e-8) break;
  }
  if (shares <= 1e-8) return null;
  return {
    shares,
    remainingShares: Math.max(0, requestedShares - shares),
    averagePrice: cost / shares,
    cost,
    fees: 0,
    makerFees: 0,
    totalCost: cost,
    rebateFeeEquivalent,
    fills,
  };
}

module.exports = {
  ENTRY_TRIGGER_SECONDS,
  ENTRY_TRIGGER_PRICE,
  STRATEGY_VERSION,
  LIMIT_ORDER_LADDER,
  quoteIsFresh,
  selectTriggeredSide,
  normalizeAskLevels,
  filterAskLevelsForLimit,
  simulateLimitBuyFill,
};
