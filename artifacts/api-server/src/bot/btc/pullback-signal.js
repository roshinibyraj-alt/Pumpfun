'use strict';

const LOOKBACK_CANDLES = 50;
const PIVOT_RADIUS = 2;

function regressionSlope(values) {
  const count = values.length;
  if (count < 2) return null;
  const meanX = (count - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < count; index++) {
    covariance += (index - meanX) * (values[index] - meanY);
    varianceX += (index - meanX) ** 2;
  }
  return varianceX > 0 ? covariance / varianceX : null;
}

function findPivots(candles, field, kind) {
  const pivots = [];
  for (let index = PIVOT_RADIUS; index < candles.length - PIVOT_RADIUS; index++) {
    const value = candles[index][field];
    const neighbors = [];
    for (let offset = 1; offset <= PIVOT_RADIUS; offset++) {
      neighbors.push(candles[index - offset][field], candles[index + offset][field]);
    }
    const isPivot = kind === 'high'
      ? neighbors.every(neighbor => value >= neighbor) && neighbors.some(neighbor => value > neighbor)
      : neighbors.every(neighbor => value <= neighbor) && neighbors.some(neighbor => value < neighbor);
    if (isPivot) {
      const pivot = { index, price: value, ts: candles[index].end };
      const previous = pivots.at(-1);
      if (previous && index - previous.index <= PIVOT_RADIUS) {
        if (kind === 'high' ? value >= previous.price : value <= previous.price) pivots[pivots.length - 1] = pivot;
      } else {
        pivots.push(pivot);
      }
    }
  }
  return pivots;
}

function detectPullback(candles, now, volatility5m, livePrice = null, previousLivePrice = null) {
  if (!Array.isArray(candles) || !Number.isFinite(now)
    || !Number.isFinite(volatility5m) || volatility5m <= 0) return null;
  const recent = candles.filter(candle => Number.isFinite(candle?.start)
    && Number.isFinite(candle?.end)
    && candle.end <= now
    && [candle.open, candle.high, candle.low, candle.close]
      .every(value => Number.isFinite(value) && value > 0))
    .sort((a, b) => a.start - b.start)
    .slice(-LOOKBACK_CANDLES);
  if (recent.length < LOOKBACK_CANDLES) return null;
  // Keep the previous bias, but never create a new signal from stale candle history.
  if (now - recent.at(-1).end > 90_000) return null;

  const closes = recent.map(candle => candle.close);
  const slope = regressionSlope(closes);
  if (!Number.isFinite(slope)) return null;
  const highs = findPivots(recent, 'high', 'high');
  const lows = findPivots(recent, 'low', 'low');
  const lastTwoHighs = highs.slice(-2);
  const lastTwoLows = lows.slice(-2);
  const haveStructure = lastTwoHighs.length === 2 && lastTwoLows.length === 2;
  const tolerance = recent.at(-1).close * 0.00002;
  const higherHighs = haveStructure && lastTwoHighs[1].price > lastTwoHighs[0].price + tolerance;
  const higherLows = haveStructure && lastTwoLows[1].price > lastTwoLows[0].price + tolerance;
  const lowerHighs = haveStructure && lastTwoHighs[1].price < lastTwoHighs[0].price - tolerance;
  const lowerLows = haveStructure && lastTwoLows[1].price < lastTwoLows[0].price - tolerance;
  const trendDirection = higherHighs && higherLows && slope > 0
    ? 'UPTREND'
    : lowerHighs && lowerLows && slope < 0 ? 'DOWNTREND' : 'MIXED';
  const meanClose = closes.reduce((sum, value) => sum + value, 0) / closes.length;
  const meanIndex = (LOOKBACK_CANDLES - 1) / 2;
  const lineStart = meanClose - slope * meanIndex;
  const lineEnd = meanClose + slope * meanIndex;
  const buffer = Math.max(recent.at(-1).close * volatility5m * 0.1, recent.at(-1).close * 0.00002);
  const upLevel = higherHighs ? lastTwoHighs.at(-1).price + buffer : null;
  const downLevel = lowerLows ? lastTwoLows.at(-1).price - buffer : null;
  const previousClosed = recent.at(-2);
  const latestClosed = recent.at(-1);
  const confirmedUpBreak = higherHighs
    && previousClosed.close <= upLevel && latestClosed.close > upLevel;
  const confirmedDownBreak = lowerLows
    && previousClosed.close >= downLevel && latestClosed.close < downLevel;
  const crossedUp = confirmedUpBreak;
  const crossedDown = confirmedDownBreak;
  const atTrendline = Number.isFinite(livePrice) && Math.abs(livePrice - lineEnd) <= buffer;
  const lowerLowTouch = lowerLows && (
    atTrendline
    || (latestClosed.low <= lineEnd + buffer && latestClosed.close > lineEnd)
  );
  const higherHighTouch = higherHighs && (
    atTrendline
    || (latestClosed.high >= lineEnd - buffer && latestClosed.close < lineEnd)
  );
  const lowerLowRejection = lowerLowTouch && !atTrendline
    && latestClosed.low <= lineEnd + buffer && latestClosed.close > lineEnd;
  const higherHighRejection = higherHighTouch && !atTrendline
    && latestClosed.high >= lineEnd - buffer && latestClosed.close < lineEnd;
  let side = null;
  let signalReason = null;
  if (confirmedUpBreak) {
    side = 'UP';
    signalReason = 'HIGHER_HIGH_BREAKOUT';
  } else if (confirmedDownBreak) {
    side = 'DOWN';
    signalReason = 'LOWER_LOW_BREAKOUT';
  } else if (lowerLowRejection !== higherHighRejection) {
    side = lowerLowRejection ? 'UP' : 'DOWN';
    signalReason = lowerLowRejection ? 'LOWER_LOW_CANDLE_REJECTION' : 'HIGHER_HIGH_CANDLE_REJECTION';
  } else if (lowerLowTouch !== higherHighTouch) {
    side = lowerLowTouch ? 'UP' : 'DOWN';
    signalReason = lowerLowTouch ? 'LOWER_LOW_TRENDLINE_TOUCH' : 'HIGHER_HIGH_TRENDLINE_TOUCH';
  }
  const currentPrice = Number.isFinite(livePrice) ? livePrice : null;

  return {
    method: 'swing50-1m-edge-reset-tpsl-v8',
    side,
    signalReason,
    signalSource: signalReason?.includes('TRENDLINE_TOUCH') ? 'LIVE_TOUCH' : signalReason ? 'CLOSED_CANDLE' : null,
    signalAt: signalReason && !signalReason.includes('TRENDLINE_TOUCH') ? latestClosed.end : null,
    candleTimeframe: '1m',
    crossed: Boolean(crossedUp || crossedDown),
    regime: signalReason ?? `WAITING_${trendDirection}`,
    trendDirection,
    structure: haveStructure
      ? `${higherHighs ? 'HH' : lowerHighs ? 'LH' : '—'} / ${higherLows ? 'HL' : lowerLows ? 'LL' : '—'}`
      : 'WAITING_FOR_SWINGS',
    lookbackCandles: LOOKBACK_CANDLES,
    trendSlopePerCandle: slope,
    breakoutLevels: { UP: upLevel, DOWN: downLevel },
    chart: {
      candles: recent.map(({ start, open, high, low, close }) => ({ start, open, high, low, close })),
      trendline: { start: lineStart, end: lineEnd },
      swingHighs: highs,
      swingLows: lows,
      currentPrice,
    },
  };
}

module.exports = { detectPullback };
