'use strict';

const METHOD = 'macd-5m-12-26-9-prior-closed-v1';
const FAST = 12;
const SLOW = 26;
const SIGNAL = 9;
const CANDLE_MS = 5 * 60_000;
const MAX_SIGNAL_AGE_MS = CANDLE_MS + 90_000;

function classifyHistogram(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current === 0 || current === previous) {
    return { side: null, classification: 'NEUTRAL' };
  }
  if (current > 0) {
    return current > previous
      ? { side: 'UP', classification: 'SOLID_GREEN' }
      : { side: 'DOWN', classification: 'SHRINKING_GREEN' };
  }
  return current > previous
    ? { side: 'UP', classification: 'SHRINKING_RED' }
    : { side: 'DOWN', classification: 'SOLID_RED' };
}

function ema(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  result[period - 1] = value;
  const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    value += alpha * (values[i] - value);
    result[i] = value;
  }
  return result;
}

function detectMacdHistogram(candles, now) {
  const base = {
    method: METHOD, timeframe: '5m', fastPeriod: FAST, slowPeriod: SLOW, signalPeriod: SIGNAL,
    status: 'WAITING_HISTORY', side: null, signalSource: 'CLOSED_CANDLE', signalAt: null,
    signalReason: null, classification: 'NEUTRAL', latestHistogram: null, previousHistogram: null,
    chart: { bars: [] },
  };
  const closed = (Array.isArray(candles) ? candles : [])
    .filter(c => Number.isFinite(c.end) && c.end <= now)
    .sort((a, b) => a.end - b.end).slice(-100);
  if (closed.some((c, i) => !Number.isFinite(c.close) || c.close <= 0
    || !Number.isFinite(c.start) || c.end - c.start !== CANDLE_MS
    || (i > 0 && c.start !== closed[i - 1].end))) {
    return { ...base, status: 'INVALID_HISTORY' };
  }
  // 26 prices seed slow EMA; 9 MACD values seed signal EMA; compare two histogram bars.
  if (closed.length < SLOW + SIGNAL) return base;
  const closes = closed.map(c => c.close);
  const fast = ema(closes, FAST);
  const slow = ema(closes, SLOW);
  const macd = slow.slice(SLOW - 1).map((value, i) => fast[i + SLOW - 1] - value);
  const signal = ema(macd, SIGNAL);
  const bars = [];
  for (let i = SIGNAL - 1; i < macd.length; i++) {
    const candle = closed[i + SLOW - 1];
    const histogram = macd[i] - signal[i];
    const previous = bars.at(-1)?.histogram;
    const classified = classifyHistogram(histogram, previous);
    bars.push({
      start: candle.start, end: candle.end, histogram, macd: macd[i], signal: signal[i],
      classification: classified.classification, side: classified.side,
    });
  }
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const classified = classifyHistogram(latest.histogram, previous.histogram);
  const stale = now - latest.end > MAX_SIGNAL_AGE_MS;
  return {
    ...base, ...classified, side: stale ? null : classified.side,
    status: stale ? 'STALE' : 'READY', signalAt: latest.end,
    signalReason: classified.side && !stale ? `MACD_${classified.classification}` : null,
    latestHistogram: latest.histogram, previousHistogram: previous.histogram,
    chart: { bars: bars.slice(-50) },
  };
}

// The immediately preceding, fully closed five-minute candle chooses direction.
function windowSignal(signal, start, now) {
  const bars = signal?.chart?.bars ?? [];
  const previousCandle = bars.find(b => b.start === start - CANDLE_MS
    && b.end === start && b.end <= now) ?? null;
  if (now < start || signal?.method !== METHOD || signal?.timeframe !== '5m'
    || signal?.status !== 'READY'
    || signal.signalAt !== start || !previousCandle) {
    return { status: 'WAITING_HISTORY', side: null, previousCandle };
  }
  const side = previousCandle.side
    ?? classifyHistogram(previousCandle.histogram, signal.previousHistogram).side;
  return {
    status: side ? 'LOCKED' : 'SKIP_WINDOW',
    side,
    previousCandle: { ...previousCandle },
    signalAt: previousCandle.end,
  };
}

module.exports = { METHOD, classifyHistogram, detectMacdHistogram, windowSignal, ema, CANDLE_MS };
