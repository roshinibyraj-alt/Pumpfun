// ============================================================
// strategy.js — pure helpers.
//   1. candleColor/colorsFromCandles/detectPattern: candle-pattern
//      side-selection logic, kept here for reference but NO LONGER
//      CALLED by bot.js as of v13 — side selection now comes from
//      config.BET_PATTERN (a fixed sequence), not from candles.
//   2. openPosition: builds the position object at the moment an entry
//      actually fires (entries are immediate/taker fills, not resting
//      orders — a position only ever gets created already-filled).
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

// Builds an ALREADY-FILLED position at the moment an entry fires.
// Entries are immediate taker fills (either the early
// EARLY_ENTRY_TRIGGER_PRICE breach, or the forced fire once
// ENTRY_WAIT_SECONDS elapses) — there's no resting/pending phase to
// model, so the position is constructed directly in 'filled' status.
// shares are derived from the dollar notional and the actual fill
// price, NOT a fixed share count.
// v12: no take-profit exit — every position rides naked straight to
// real resolution, so there's no tpPrice/tpFill* bookkeeping anymore;
// status only ever goes filled -> resolved_win | resolved_loss.
function openPosition(windowStart, windowEnd, side, tokenId, notional, fillPrice, entryReason, config) {
  const shares = Math.round((notional / fillPrice) * 10000) / 10000;
  const fillFee = Math.round(shares * config.BASE_TAKER_FEE_RATE * fillPrice * (1 - fillPrice) * 100000) / 100000;
  return {
    windowStart,
    windowEnd,
    side,
    tokenId,
    notional,
    shares,
    fillPrice,
    fillFee,      // taker fee — entry is an immediate fill, not maker
    fillRebate: 0, // no maker rebate on a taker fill
    filledAt: new Date().toISOString(),
    entryReason,
    // filled -> resolved_win | resolved_loss
    status: 'filled',
    resolvedWon: null,
    cost: null,
    payout: null,
    pnl: null,
    settledAt: null,
  };
}

module.exports = { candleColor, colorsFromCandles, detectPattern, openPosition };
