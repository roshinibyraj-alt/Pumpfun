'use strict';

const METHOD = 'macd-1m-12-26-9-window-pair-v2';
const FAST = 12;
const SLOW = 26;
const SIGNAL = 9;

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
    method: METHOD, timeframe: '1m', fastPeriod: FAST, slowPeriod: SLOW, signalPeriod: SIGNAL,
    status: 'WAITING_HISTORY', side: null, signalSource: 'CLOSED_CANDLE', signalAt: null,
    signalReason: null, classification: 'NEUTRAL', latestHistogram: null, previousHistogram: null,
    chart: { bars: [] },
  };
  const closed = (Array.isArray(candles) ? candles : [])
    .filter(c => Number.isFinite(c.end) && c.end <= now)
    .sort((a, b) => a.end - b.end).slice(-100);
  if (closed.some((c, i) => !Number.isFinite(c.close) || c.close <= 0
    || !Number.isFinite(c.start) || c.end - c.start !== 60_000
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
    bars.push({
      start: candle.start, end: candle.end, histogram, macd: macd[i], signal: signal[i],
      classification: classifyHistogram(histogram, previous).classification,
    });
  }
  const latest = bars.at(-1);
  const previous = bars.at(-2);
  const classified = classifyHistogram(latest.histogram, previous.histogram);
  const stale = now - latest.end > 90_000;
  return {
    ...base, ...classified, side: stale ? null : classified.side,
    status: stale ? 'STALE' : 'READY', signalAt: latest.end,
    signalReason: classified.side && !stale ? `MACD_${classified.classification}` : null,
    latestHistogram: latest.histogram, previousHistogram: previous.histogram,
    chart: { bars: bars.slice(-50) },
  };
}

// Only the first two fully closed candles of this exact market can choose direction.
function windowSignal(signal, start, now) {
  const bars = signal?.chart?.bars ?? [];
  const first = bars.find(b => b.start === start && b.end === start + 60_000 && b.end <= now);
  const second = bars.find(b => b.start === start + 60_000 && b.end === start + 120_000 && b.end <= now);
  if (now < start + 120_000) return { status: 'OBSERVING', side: null, minute1: first ?? null };
  if (signal?.status !== 'READY') return { status: 'WAITING_HISTORY', side: null };
  if (!first || !second) return { status: 'WAITING_HISTORY', side: null };
  const up = first.classification === 'SOLID_RED'
    && ['SHRINKING_RED', 'SOLID_GREEN'].includes(second.classification)
    || first.classification === 'SOLID_GREEN' && second.classification === 'SOLID_GREEN';
  const down = first.classification === 'SOLID_GREEN'
    && ['SHRINKING_GREEN', 'SOLID_RED'].includes(second.classification)
    || first.classification === 'SOLID_RED' && second.classification === 'SOLID_RED';
  return {
    status: up || down ? 'LOCKED' : 'SKIP_WINDOW',
    side: up ? 'UP' : down ? 'DOWN' : null,
    minute1: { ...first }, minute2: { ...second },
    signalAt: second.end,
  };
}

module.exports = { METHOD, classifyHistogram, detectMacdHistogram, windowSignal, ema };
