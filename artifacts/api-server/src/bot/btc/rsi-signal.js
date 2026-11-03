'use strict';

const CANDLE_MS = 5 * 60_000;
const RSI_PERIOD = 14;
const OVERSOLD = 30;
const OVERBOUGHT = 70;
const METHOD = 'rsi-5m-14-hysteresis-v1';

function rsiValue(previous) {
  if (previous.averageGain === 0 && previous.averageLoss === 0) return 50;
  if (previous.averageLoss === 0) return 100;
  if (previous.averageGain === 0) return 0;
  const relativeStrength = previous.averageGain / previous.averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

function detectRsiSignal(candles, now) {
  const base = {
    method: METHOD,
    timeframe: '5m',
    period: RSI_PERIOD,
    overbought: OVERBOUGHT,
    oversold: OVERSOLD,
    status: 'WAITING_HISTORY',
    value: null,
    bucket: null,
    side: null,
    signalAt: null,
    history: [],
    reason: 'Waiting for 15 contiguous, closed five-minute candles.',
  };
  if (!Number.isFinite(now)) {
    return { ...base, status: 'INVALID_HISTORY', reason: 'Current time is unavailable.' };
  }

  const closed = (Array.isArray(candles) ? candles : [])
    .filter(candle => Number.isFinite(Number(candle?.start))
      && Number.isFinite(Number(candle?.end))
      && Number.isFinite(Number(candle?.close))
      && Number(candle.close) > 0
      && Number(candle.end) - Number(candle.start) === CANDLE_MS
      && Number(candle.end) <= now)
    .map(candle => ({
      start: Number(candle.start),
      end: Number(candle.end),
      close: Number(candle.close),
    }))
    .sort((a, b) => a.end - b.end);

  const expectedEnd = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  const latest = closed.at(-1);
  if (!latest || latest.end !== expectedEnd) {
    return {
      ...base,
      status: 'STALE',
      signalAt: latest?.end ?? null,
      reason: 'The latest closed five-minute candle is missing or stale.',
    };
  }

  // Start at the most recent uninterrupted run so a historical data gap
  // cannot be silently smoothed across.
  let suffixStart = closed.length - 1;
  while (suffixStart > 0
    && closed[suffixStart - 1].end === closed[suffixStart].start) {
    suffixStart--;
  }
  const contiguous = closed.slice(suffixStart);
  if (contiguous.length < RSI_PERIOD + 1) {
    return {
      ...base,
      status: 'WAITING_HISTORY',
      signalAt: latest.end,
      reason: `Need ${RSI_PERIOD + 1} contiguous closed candles; found ${contiguous.length}.`,
    };
  }

  const changes = contiguous.slice(1).map((candle, index) => candle.close - contiguous[index].close);
  let averageGain = changes.slice(0, RSI_PERIOD)
    .reduce((sum, change) => sum + Math.max(0, change), 0) / RSI_PERIOD;
  let averageLoss = changes.slice(0, RSI_PERIOD)
    .reduce((sum, change) => sum + Math.max(0, -change), 0) / RSI_PERIOD;
  let value = rsiValue({ averageGain, averageLoss });
  const history = [{
    start: contiguous[RSI_PERIOD].start,
    end: contiguous[RSI_PERIOD].end,
    value,
  }];

  for (let index = RSI_PERIOD; index < changes.length; index++) {
    const change = changes[index];
    averageGain = (averageGain * (RSI_PERIOD - 1) + Math.max(0, change)) / RSI_PERIOD;
    averageLoss = (averageLoss * (RSI_PERIOD - 1) + Math.max(0, -change)) / RSI_PERIOD;
    value = rsiValue({ averageGain, averageLoss });
    const candle = contiguous[index + 1];
    history.push({ start: candle.start, end: candle.end, value });
  }

  const side = value < OVERSOLD ? 'UP' : value > OVERBOUGHT ? 'DOWN' : null;
  const bucket = value < OVERSOLD ? 'OVERSOLD'
    : value > OVERBOUGHT ? 'OVERBOUGHT' : 'NEUTRAL';
  return {
    ...base,
    status: 'READY',
    value,
    bucket,
    side,
    signalAt: latest.end,
    history: history.slice(-50),
    reason: side === 'UP' ? 'RSI is below 30 (oversold).'
      : side === 'DOWN' ? 'RSI is above 70 (overbought).'
        : 'RSI is between the thresholds; retain the last selected side.',
  };
}

module.exports = { METHOD, CANDLE_MS, RSI_PERIOD, OVERSOLD, OVERBOUGHT, detectRsiSignal };
