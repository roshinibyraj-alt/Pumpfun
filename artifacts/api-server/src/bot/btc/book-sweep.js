'use strict';

const { CRYPTO_TAKER_FEE_RATE } = require('./config');

// No artificial slippage cap: consume real visible levels, never extrapolated liquidity.
function sweepBook(levels, requestedShares, direction) {
  if (!Number.isFinite(requestedShares) || requestedShares <= 0) return null;
  const sorted = (Array.isArray(levels) ? levels : [])
    .map(l => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(l => Number.isFinite(l.price) && l.price > 0 && l.price < 1
      && Number.isFinite(l.size) && l.size > 0)
    .sort((a, b) => direction === 'sell' ? b.price - a.price : a.price - b.price);
  let remaining = requestedShares;
  let value = 0;
  let fees = 0;
  const remainingLevels = [];
  for (const level of sorted) {
    const quantity = Math.min(remaining, level.size);
    value += quantity * level.price;
    fees += CRYPTO_TAKER_FEE_RATE * level.price * (1 - level.price) * quantity;
    remaining -= quantity;
    if (level.size > quantity) remainingLevels.push({ price: level.price, size: level.size - quantity });
  }
  const shares = requestedShares - remaining;
  if (shares <= 1e-8) return null;
  return {
    shares, averagePrice: value / shares, cost: value, fees,
    totalCost: value + fees, netPayout: value - fees,
    remainingShares: remaining, remainingLevels,
  };
}

module.exports = { sweepBook };
