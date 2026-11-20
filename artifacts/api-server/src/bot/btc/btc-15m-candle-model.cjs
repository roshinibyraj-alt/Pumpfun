'use strict';

const WINDOW_MS = 15 * 60_000;
const MIN_DIRECTION_RETURN_PCT = 0.03;
const MIN_MEAN_REVERSION_RANGE_RATIO = 1.4;
const MIN_MEAN_REVERSION_Z = 1.3;
const MIN_REJECTION_WICK_RATIO = 0.4;
const SCORE_THRESHOLD = 2;

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function candleDirection(candle) {
  const returnPct = ((Number(candle.close) / Number(candle.open)) - 1) * 100;
  if (returnPct >= MIN_DIRECTION_RETURN_PCT) return 'UP';
  if (returnPct <= -MIN_DIRECTION_RETURN_PCT) return 'DOWN';
  return 'FLAT';
}

function candleSummary(candle) {
  const range = Number(candle.high) - Number(candle.low);
  const closeLocation = range > 0
    ? (Number(candle.close) - Number(candle.low)) / range
    : 0.5;
  return {
    start: candle.start,
    end: candle.end,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    returnPct: ((Number(candle.close) / Number(candle.open)) - 1) * 100,
    direction: candleDirection(candle),
    closeLocation,
  };
}

function closedBefore(candles, windowStart) {
  return (Array.isArray(candles) ? candles : [])
    .filter(candle => Number(candle?.end) <= windowStart
      && [candle.open, candle.high, candle.low, candle.close]
        .every(value => Number.isFinite(Number(value)) && Number(value) > 0))
    .sort((left, right) => Number(left.start) - Number(right.start));
}

function assessMeanReversion(closed15m) {
  if (closed15m.length < 21) {
    return {
      side: null,
      points: 0,
      status: 'INSUFFICIENT_HISTORY',
      explanation: 'Need 20 earlier closed 15-minute candles to assess extension.',
      zScore: null,
      rangeRatio: null,
      upperWickRatio: null,
      lowerWickRatio: null,
    };
  }
  const candle = closed15m.at(-1);
  const prior = closed15m.slice(-21, -1);
  const closes = prior.map(item => Number(item.close));
  const average = mean(closes);
  const deviation = standardDeviation(closes);
  const zScore = deviation > 0 ? (Number(candle.close) - average) / deviation : 0;
  const priorMedianRange = median(prior.map(item =>
    ((Number(item.high) - Number(item.low)) / Number(item.open)) * 100));
  const rangePct = ((Number(candle.high) - Number(candle.low)) / Number(candle.open)) * 100;
  const rangeRatio = priorMedianRange > 0 ? rangePct / priorMedianRange : 0;
  const fullRange = Number(candle.high) - Number(candle.low);
  const upperWickRatio = fullRange > 0
    ? (Number(candle.high) - Math.max(Number(candle.open), Number(candle.close))) / fullRange
    : 0;
  const lowerWickRatio = fullRange > 0
    ? (Math.min(Number(candle.open), Number(candle.close)) - Number(candle.low)) / fullRange
    : 0;
  const closeLocation = fullRange > 0
    ? (Number(candle.close) - Number(candle.low)) / fullRange : 0.5;

  if (zScore >= MIN_MEAN_REVERSION_Z
    && rangeRatio >= MIN_MEAN_REVERSION_RANGE_RATIO
    && upperWickRatio >= MIN_REJECTION_WICK_RATIO
    && closeLocation <= 0.65) {
    return {
      side: 'DOWN',
      points: -2,
      status: 'UPWARD_EXTENSION_REJECTED',
      explanation: 'The 15-minute close was stretched above its recent mean and rejected from its high.',
      zScore,
      rangeRatio,
      upperWickRatio,
      lowerWickRatio,
    };
  }
  if (zScore <= -MIN_MEAN_REVERSION_Z
    && rangeRatio >= MIN_MEAN_REVERSION_RANGE_RATIO
    && lowerWickRatio >= MIN_REJECTION_WICK_RATIO
    && closeLocation >= 0.35) {
    return {
      side: 'UP',
      points: 2,
      status: 'DOWNWARD_EXTENSION_REJECTED',
      explanation: 'The 15-minute close was stretched below its recent mean and rejected from its low.',
      zScore,
      rangeRatio,
      upperWickRatio,
      lowerWickRatio,
    };
  }
  return {
    side: null,
    points: 0,
    status: 'NO_CLEAR_REJECTION',
    explanation: 'No strong 15-minute extension-and-rejection pattern was found.',
    zScore,
    rangeRatio,
    upperWickRatio,
    lowerWickRatio,
  };
}

function describeTrend(timeframe, candle) {
  const direction = candleDirection(candle);
  const returnPct = ((Number(candle.close) / Number(candle.open)) - 1) * 100;
  const weight = timeframe === '4h' ? 2 : 1;
  const points = direction === 'UP' ? weight : direction === 'DOWN' ? -weight : 0;
  return {
    timeframe,
    direction,
    points,
    returnPct,
    candle: candleSummary(candle),
    explanation: `${timeframe} candle ${direction.toLowerCase()} ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(3)}%.`,
  };
}

function hourSlot(windowStart) {
  const date = new Date(windowStart);
  const minute = date.getUTCMinutes();
  const slotIndex = Math.floor(minute / 15);
  const labels = ['00–15', '15–30', '30–45', '45–60'];
  const localTime = value => new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
  return {
    index: slotIndex,
    label: `Quarter ${slotIndex + 1}/4`,
    rangeUtc: `${labels[slotIndex]} UTC`,
    rangeBrisbane: `${localTime(windowStart)}–${localTime(windowStart + WINDOW_MS)} Brisbane`,
    minuteUtc: minute,
    directionalPoints: 0,
    explanation: 'Shown as context only; no time-of-hour directional bias is assumed without evidence.',
  };
}

function analyze15mWindow({ candles, windowStart, feedUpdatedAt, now = Date.now() }) {
  const slot = hourSlot(windowStart);
  if (!Number.isFinite(Number(windowStart))) {
    return { status: 'WAITING_DATA', side: null, reason: 'The 15-minute market start time is unavailable.', slot };
  }
  if (!Number.isFinite(Number(feedUpdatedAt)) || now - Number(feedUpdatedAt) > 120_000) {
    return { status: 'WAITING_DATA', side: null, reason: 'Binance candle data is not fresh enough.', slot };
  }
  const history15m = closedBefore(candles?.['15m'], windowStart);
  const history1h = closedBefore(candles?.['1h'], windowStart);
  const history4h = closedBefore(candles?.['4h'], windowStart);
  if (history15m.length < 21 || !history1h.length || !history4h.length) {
    return {
      status: 'WAITING_DATA',
      side: null,
      reason: 'Waiting for 20 earlier 15-minute candles and closed 1-hour and 4-hour candles.',
      slot,
      available: { '15m': history15m.length, '1h': history1h.length, '4h': history4h.length },
    };
  }
  const last15m = history15m.at(-1);
  if (windowStart - Number(last15m.end) > 60_000) {
    return {
      status: 'WAITING_DATA',
      side: null,
      reason: 'The latest closed 15-minute candle is too old for this window.',
      slot,
      available: { '15m': history15m.length, '1h': history1h.length, '4h': history4h.length },
    };
  }

  const trends = [
    describeTrend('15m', last15m),
    describeTrend('1h', history1h.at(-1)),
    describeTrend('4h', history4h.at(-1)),
  ];
  const meanReversion = assessMeanReversion(history15m);
  const score = trends.reduce((sum, item) => sum + item.points, 0) + meanReversion.points;
  const side = score >= SCORE_THRESHOLD ? 'UP'
    : score <= -SCORE_THRESHOLD ? 'DOWN' : null;
  const factors = [
    ...trends,
    {
      timeframe: 'Mean reversion',
      direction: meanReversion.side || 'NEUTRAL',
      points: meanReversion.points,
      explanation: meanReversion.explanation,
      zScore: meanReversion.zScore,
      rangeRatio: meanReversion.rangeRatio,
    },
    {
      timeframe: 'Hour slot',
      direction: 'CONTEXT',
      points: 0,
      explanation: slot.explanation,
    },
  ];
  return {
    status: side ? 'SIGNAL' : 'NO_SIGNAL',
    side,
    score,
    threshold: SCORE_THRESHOLD,
    reason: side
      ? `${side} selected from a ${score > 0 ? '+' : ''}${score}-point candle evidence score.`
      : `No trade: the evidence score (${score > 0 ? '+' : ''}${score}) did not reach ±${SCORE_THRESHOLD}.`,
    windowStart,
    calculatedAt: now,
    slot,
    inputs: {
      '15m': candleSummary(last15m),
      '1h': candleSummary(history1h.at(-1)),
      '4h': candleSummary(history4h.at(-1)),
      meanReversion,
      historyCount: { '15m': history15m.length, '1h': history1h.length, '4h': history4h.length },
    },
    factors,
    disclaimer: 'Heuristic evidence score, not a calibrated probability or a guarantee of profit.',
  };
}

module.exports = {
  WINDOW_MS,
  analyze15mWindow,
  assessMeanReversion,
  candleDirection,
  candleSummary,
  hourSlot,
};
