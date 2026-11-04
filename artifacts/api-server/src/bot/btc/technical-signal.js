'use strict';

const { candleColor } = require('./candle-strategy');

const METHOD = 'closed-5m-candle-color-doji-streak-v1';
const FIVE_MINUTES = 5 * 60_000;

function validNumber(value) {
  return value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
}

function closedContiguousCandles(input, intervalMs, now) {
  const sorted = (Array.isArray(input) ? input : [])
    .filter(candle => {
      const start = Number(candle?.start);
      const end = Number(candle?.end);
      const open = Number(candle?.open);
      const high = Number(candle?.high);
      const low = Number(candle?.low);
      const close = Number(candle?.close);
      return Number.isFinite(start) && Number.isFinite(end)
        && end - start === intervalMs && end <= now
        && [open, high, low, close].every(value => Number.isFinite(value) && value > 0)
        && high >= low && high >= open && high >= close
        && low <= open && low <= close;
    })
    .map(candle => ({
      start: Number(candle.start),
      end: Number(candle.end),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }))
    .sort((a, b) => a.end - b.end)
    .filter((candle, index, all) => index === 0 || candle.end !== all[index - 1].end);

  if (!sorted.length) return [];
  let first = sorted.length - 1;
  while (first > 0 && sorted[first - 1].end === sorted[first].start) first--;
  return sorted.slice(first);
}

function signalForClosedCandleSequence(candles) {
  const colored = candles.map(candle => ({
    ...candle,
    color: candleColor(candle.open, candle.close, candle.high, candle.low),
  }));
  const latest = colored.at(-1);
  if (!latest) {
    return {
      side: null,
      setup: 'WAITING_FOR_CLOSED_CANDLE',
      reason: 'No closed five-minute candle is available.',
      candle: null,
    };
  }

  let side = null;
  let setup;
  let reason;
  let priorColor = null;
  let consecutivePriorCandles = 0;

  if (latest.color === 'GREEN') {
    side = 'UP';
    setup = 'PREVIOUS_GREEN';
    reason = 'UP because the latest closed five-minute candle was green.';
  } else if (latest.color === 'RED') {
    side = 'DOWN';
    setup = 'PREVIOUS_RED';
    reason = 'DOWN because the latest closed five-minute candle was red.';
  } else {
    for (let index = colored.length - 2; index >= 0; index--) {
      const color = colored[index].color;
      if (color !== 'GREEN' && color !== 'RED') break;
      if (priorColor === null) priorColor = color;
      if (color !== priorColor) break;
      consecutivePriorCandles++;
    }

    if (priorColor === 'GREEN' && consecutivePriorCandles >= 2) {
      side = 'DOWN';
      setup = 'DOJI_AFTER_GREEN_RUN';
      reason = `DOWN because a doji followed ${consecutivePriorCandles} consecutive green candles.`;
    } else if (priorColor === 'RED' && consecutivePriorCandles >= 2) {
      side = 'UP';
      setup = 'DOJI_AFTER_RED_RUN';
      reason = `UP because a doji followed ${consecutivePriorCandles} consecutive red candles.`;
    } else {
      setup = 'DOJI_NO_DIRECTION';
      reason = 'No side selected: the doji was not preceded by two consecutive candles of the same color.';
    }
  }

  const range = latest.high - latest.low;
  const bodyFraction = range > 0 ? Math.abs(latest.close - latest.open) / range : 0;

  return {
    side,
    setup,
    reason,
    candle: {
      color: latest.color,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      end: latest.end,
      bodyFraction,
      priorColor,
      consecutivePriorCandles,
    },
  };
}

function detectTechnicalSignal({ candles5m, now }) {
  const base = {
    method: METHOD,
    timeframe: '5m',
    status: 'WAITING_HISTORY',
    side: null,
    setup: null,
    pattern: null,
    confirmed: false,
    signalAt: null,
    reason: 'Waiting for the latest closed five-minute candle.',
    candle: null,
  };

  if (!Number.isFinite(now)) {
    return { ...base, status: 'INVALID_HISTORY', reason: 'Current time is unavailable.' };
  }

  const candles = closedContiguousCandles(candles5m, FIVE_MINUTES, now);
  const latest = candles.at(-1);
  const expectedEnd = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
  if (!latest || latest.end !== expectedEnd) {
    return {
      ...base,
      status: 'STALE',
      signalAt: latest?.end ?? null,
      reason: 'The latest closed five-minute candle is missing or stale.',
    };
  }

  const selected = signalForClosedCandleSequence(candles);
  return {
    ...base,
    status: selected.side ? 'READY' : 'NO_SIGNAL',
    side: selected.side,
    setup: selected.setup,
    pattern: selected.setup,
    confirmed: Boolean(selected.side),
    signalAt: latest.end,
    reason: selected.reason,
    candle: selected.candle,
  };
}

module.exports = {
  METHOD,
  detectTechnicalSignal,
  closedContiguousCandles,
  signalForClosedCandleSequence,
};
