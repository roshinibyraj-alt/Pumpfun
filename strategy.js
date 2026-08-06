// ============================================================
// strategy.js — pure math/data helpers for the dip-buy + take-profit
// strategy. No ladder, no counter-bet, no hedge. Just: build the two
// (UP, DOWN) positions for a fresh window, both starting inactive
// until the entry condition fires.
// ============================================================

// Builds the two positions (one UP, one DOWN) for a new window. Both
// start in 'inactive' status — they only become live orders once the
// entry condition (checked in bot.js from ENTRY_CHECK_MINUTE onward)
// fires, which flips both to 'order_pending' at the same time.
function buildPositions(windowStart, windowEnd, upTokenId, downTokenId, shares, config) {
  const positions = [];
  for (const side of ['UP', 'DOWN']) {
    positions.push({
      windowStart,
      windowEnd,
      side,
      tokenId: side === 'UP' ? upTokenId : downTokenId,
      shares,
      orderPrice: config.LIMIT_BUY_PRICE,
      tpPrice: config.TAKE_PROFIT_PRICE,
      // inactive -> order_pending -> filled -> tp_filled | resolved_win | resolved_loss
      //                            -> order_cancelled (never filled, window closed)
      status: 'inactive',
      orderPlacedAt: null,
      fillPrice: null,
      fillFee: null,
      fillRebate: null,
      filledAt: null,
      tpFillPrice: null,
      tpFillFee: null,
      tpFillRebate: null,
      tpFilledAt: null,
      cancelledAt: null,
      resolvedWon: null,
      cost: null,
      payout: null,
      pnl: null,
      settledAt: null,
    });
  }
  return positions;
}

module.exports = { buildPositions };
