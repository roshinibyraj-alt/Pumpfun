// ============================================================
// strategy.js — pure helpers for the candle-pattern directional
// strategy. No ladder, no hedge, no dual-side dip-buy. Two jobs:
//   1. Turn a run of candles into a Green/Red pattern + trade signal.
//   2. Build the single position object for whichever side (if any)
//      the pattern signals.
// ============================================================

// Green if it closed up, Red if it closed down, Neutral (doji) if
// unchanged. A Neutral candle breaks any streak it's part of — it
// isn't a wildcard.
function candleColor(candle) {
  if (candle.close > candle.open) return 'G';
  if (candle.close < candle.open) return 'R';
  return 'N';
}

function colorsFromCandles(candles) {
  return candles.map(candleColor);
}

// Pattern table, longest/most-specific matches checked first so e.g.
// GRG chop overrides what the trailing 2 candles (RG) alone would
// otherwise signal as a reversal.
//   GGG / RRR        -> momentum continuation, trade WITH it
//   GG  / RR         -> momentum continuation, trade WITH it
//   GR                -> reversal (buyer exhaustion)  -> trade DOWN
//   RG                -> reversal (seller exhaustion) -> trade UP
//   GRG / RGR / GRGR  -> chop / whipsaw -> no trade
//   anything else (neutral candle present, or not enough data) -> no trade
//
// `colors` is chronological, oldest first, most recent last.
function detectPattern(colors) {
  const n = colors.length;
  const tail = (k) => colors.slice(n - k).join('');
  const clean = (k) => n >= k && colors.slice(n - k).every((c) => c === 'G' || c === 'R');

  if (clean(4)) {
    const s = tail(4);
    if (s === 'GRGR' || s === 'RGRG') {
      return { pattern: s, signal: 'CHOP', side: null };
    }
  }
  if (clean(3)) {
    const s = tail(3);
    if (s === 'GGG') return { pattern: s, signal: 'MOMENTUM_UP', side: 'UP' };
    if (s === 'RRR') return { pattern: s, signal: 'MOMENTUM_DOWN', side: 'DOWN' };
    if (s === 'GRG' || s === 'RGR') return { pattern: s, signal: 'CHOP', side: null };
  }
  if (clean(2)) {
    const s = tail(2);
    if (s === 'GG') return { pattern: s, signal: 'MOMENTUM_UP', side: 'UP' };
    if (s === 'RR') return { pattern: s, signal: 'MOMENTUM_DOWN', side: 'DOWN' };
    if (s === 'GR') return { pattern: s, signal: 'REVERSAL_DOWN', side: 'DOWN' };
    if (s === 'RG') return { pattern: s, signal: 'REVERSAL_UP', side: 'UP' };
  }
  return { pattern: colors.join(''), signal: 'NONE', side: null };
}

// Builds the single live position for the signaled side. Only ever
// called when detectPattern() returned a non-null side AND the entry
// sanity price check passed.
function buildPosition(windowStart, windowEnd, side, tokenId, shares, config) {
  return {
    windowStart,
    windowEnd,
    side,
    tokenId,
    shares,
    orderPrice: config.LIMIT_BUY_PRICE,
    tpPrice: config.TAKE_PROFIT_PRICE,
    // order_pending -> filled -> tp_filled | resolved_win | resolved_loss
    //               -> order_cancelled (never filled, window closed)
    status: 'order_pending',
    orderPlacedAt: new Date().toISOString(),
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
  };
}

module.exports = { candleColor, colorsFromCandles, detectPattern, buildPosition };
