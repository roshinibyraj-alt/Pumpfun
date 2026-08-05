// ============================================================
// strategy.js — pure math helpers for the ladder + counter-bet
// lock strategy. No prediction model anymore — this is just:
// build the rung ladder, and compute the counter price once a
// rung's base leg fills.
// ============================================================

// Builds the fresh set of rungs for a new window: one entry per
// (side, price) combination, all starting in 'waiting_base' status.
function buildRungs(windowStart, windowEnd, upTokenId, downTokenId, config) {
  const rungs = [];
  for (const side of ['UP', 'DOWN']) {
    for (const rungPrice of config.RUNG_PRICES) {
      rungs.push({
        windowStart,
        windowEnd,
        side,
        rungPrice,
        shares: config.SHARES_PER_RUNG,
        tokenId: side === 'UP' ? upTokenId : downTokenId,
        counterTokenId: side === 'UP' ? downTokenId : upTokenId,
        status: 'waiting_base', // waiting_base -> base_pending -> base_filled -> counter_filled
        baseOrderPrice: null,
        baseOrderPlacedAt: null,
        baseFillPrice: null,
        baseFillFee: null,
        baseFilledAt: null,
        counterPrice: null,
        counterFillPrice: null,
        counterFillFee: null,
        counterFilledAt: null,
        lockedProfit: null,
        resolvedWon: null,
        pnl: null,
        settledAt: null,
      });
    }
  }
  return rungs;
}

// Price for the counter/hedge leg once the base leg has filled at basePrice.
function counterPriceFor(basePrice, lockSpread) {
  return Math.round((1 - basePrice - lockSpread) * 1000) / 1000;
}

module.exports = { buildRungs, counterPriceFor };
