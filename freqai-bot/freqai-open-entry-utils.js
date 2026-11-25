'use strict';

function isFresh(quote, now) {
  const updatedAt = Number(quote?.updatedAt);
  return Number.isFinite(updatedAt) && now >= updatedAt - 1000 && now - updatedAt <= 2000;
}

function feeRateFor(market) {
  const rate = market?.feesEnabled === false ? 0 : Number(market?.feeSchedule?.rate ?? 0.05);
  return Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : null;
}

module.exports = { isFresh, feeRateFor };
