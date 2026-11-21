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

function assessCandleStreak(closed15m) {
  if (!Array.isArray(closed15m) || closed15m.length < 2) {
    return {
      side: null,
      direction: 'UNAVAILABLE',
      count: 0,
      status: 'INSUFFICIENT_HISTORY',
    };
  }

  const colorOf = candle => {
    const open = Number(candle.open);
    const close = Number(candle.close);
    return close > open ? 'UP' : close < open ? 'DOWN' : 'FLAT';
  };
  const latestDirection = colorOf(closed15m.at(-1));
  if (latestDirection === 'FLAT') {
    return { side: null, direction: 'FLAT', count: 0, status: 'INACTIVE' };
  }

  let count = 0;
  for (let index = closed15m.length - 1; index >= 0; index -= 1) {
    if (colorOf(closed15m[index]) !== latestDirection) break;
    count += 1;
  }

  if (latestDirection === 'DOWN' && count === 1) {
    let precedingGreenCount = 0;
    for (let index = closed15m.length - 2; index >= 0; index -= 1) {
      if (colorOf(closed15m[index]) !== 'UP') break;
      precedingGreenCount += 1;
    }
    if (precedingGreenCount >= 2) {
      return {
        side: 'DOWN',
        direction: latestDirection,
        count,
        precedingGreenCount,
        pattern: 'FIRST_RED_AFTER_GREEN_RUN',
        status: 'REVERSAL',
      };
    }
  }

  return {
    side: count >= 2 ? latestDirection : null,
    direction: latestDirection,
    count,
    precedingGreenCount: 0,
    pattern: count >= 2 ? 'SAME_COLOR_STREAK' : null,
    status: count >= 2 ? 'ACTIVE' : 'INACTIVE',
  };
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
  if (history15m.length < 21 || !history1h.length) {
    return {
      status: 'WAITING_DATA',
      side: null,
      reason: 'Waiting for 20 earlier closed 15-minute candles and a closed 1-hour candle.',
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
  ];
  const meanReversion = assessMeanReversion(history15m);
  const candleStreak = assessCandleStreak(history15m);
  const score = trends.reduce((sum, item) => sum + item.points, 0) + meanReversion.points;
  const context4h = history4h.length ? candleSummary(history4h.at(-1)) : null;
  const scoreSide = score >= SCORE_THRESHOLD ? 'UP'
    : score <= -SCORE_THRESHOLD ? 'DOWN' : null;
  const side = candleStreak.side || scoreSide;
  const signalSource = candleStreak.status === 'REVERSAL'
    ? 'GREEN_RUN_RED_REVERSAL'
    : candleStreak.side ? 'CANDLE_STREAK_SELECTOR'
      : scoreSide ? 'EVIDENCE_SCORE' : null;
  const streakExplanation = candleStreak.status === 'REVERSAL'
    ? `${candleStreak.precedingGreenCount} consecutive green 15-minute closes were followed by the first red close; the reversal selector chooses DOWN.`
    : candleStreak.status === 'ACTIVE'
    ? `${candleStreak.count} consecutive closed 15-minute candles were ${candleStreak.direction.toLowerCase()}; the streak selector chooses ${candleStreak.side}.`
    : candleStreak.direction === 'UNAVAILABLE'
      ? 'Not enough closed 15-minute candles to evaluate the streak selector.'
      : `${candleStreak.count} consecutive ${candleStreak.direction.toLowerCase()} candle${candleStreak.count === 1 ? '' : 's'} at the end of history; no streak override, so the evidence score selects the side.`;
  const factors = [
    ...trends,
    {
      timeframe: 'Candle streak selector',
      direction: ['ACTIVE', 'REVERSAL'].includes(candleStreak.status)
        ? candleStreak.side : 'INACTIVE',
      points: 0,
      explanation: streakExplanation,
      status: candleStreak.status,
      consecutiveCandles: candleStreak.count,
      precedingGreenCandles: candleStreak.precedingGreenCount || 0,
    },
    {
      timeframe: 'Mean reversion',
      direction: meanReversion.side || 'NEUTRAL',
      points: meanReversion.points,
      explanation: meanReversion.explanation,
      zScore: meanReversion.zScore,
      rangeRatio: meanReversion.rangeRatio,
    },
    {
      timeframe: '4h context only',
      direction: context4h?.direction || 'UNAVAILABLE',
      points: 0,
      explanation: context4h
        ? 'Shown for background only; the 4-hour candle is excluded from the score.'
        : 'No closed 4-hour candle is available; it is not required for a decision.',
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
    baseSide: scoreSide,
    signalSource,
    score,
    threshold: SCORE_THRESHOLD,
    reason: side
      ? candleStreak.status === 'REVERSAL'
        ? `DOWN selected by the first red close after ${candleStreak.precedingGreenCount} consecutive green 15-minute candles; the existing evidence score was ${score > 0 ? '+' : ''}${score}.`
        : candleStreak.side
          ? `${side} selected by the ${candleStreak.count}-candle ${candleStreak.direction.toLowerCase()} streak selector; the existing evidence score was ${score > 0 ? '+' : ''}${score}.`
          : `${side} selected from a ${score > 0 ? '+' : ''}${score}-point candle evidence score.`
      : `No trade: the evidence score (${score > 0 ? '+' : ''}${score}) did not reach ±${SCORE_THRESHOLD}.`,
    windowStart,
    calculatedAt: now,
    slot,
    inputs: {
      '15m': candleSummary(last15m),
      '1h': candleSummary(history1h.at(-1)),
      '4h': context4h,
      meanReversion,
      candleStreak,
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
  assessCandleStreak,
  candleDirection,
  candleSummary,
  hourSlot,
};
