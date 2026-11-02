'use strict';

const LOOKBACK_CANDLES = 15;
const TREND_CANDLES = 12;

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

function detectPullback(candles, now, volatility5m) {
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

  // Fit the earlier 12 closes, then compare the final 3 closed candles against that trend.
  const trendCloses = recent.slice(0, TREND_CANDLES).map(candle => candle.close);
  const base = trendCloses[0];
  const slope = regressionSlope(trendCloses);
  if (!Number.isFinite(slope)) return null;
  const trendMove = slope * (trendCloses.length - 1);
  const recentMove = recent.at(-1).close - recent[TREND_CANDLES - 1].close;
  const expectedMove = base * volatility5m * Math.sqrt(TREND_CANDLES);
  const minimumImpulse = Math.max(expectedMove * 0.6, base * 0.00008);
  const retracementRatio = Math.abs(trendMove) > 0
    ? Math.abs(recentMove) / Math.abs(trendMove) : 0;

  if (trendMove >= minimumImpulse && recentMove <= -Math.abs(trendMove) * 0.35) {
    return {
      side: 'DOWN',
      regime: 'PULLBACK_AFTER_RISE',
      impulseMove: trendMove,
      retracementMove: -recentMove,
      retracementRatio,
      expectedMove,
      lookbackCandles: LOOKBACK_CANDLES,
      trendSlopePerCandle: slope,
      extremeAt: recent[TREND_CANDLES - 1].end,
    };
  }

  if (trendMove <= -minimumImpulse && recentMove >= Math.abs(trendMove) * 0.35) {
    return {
      side: 'UP',
      regime: 'PULLBACK_AFTER_FALL',
      impulseMove: Math.abs(trendMove),
      retracementMove: recentMove,
      retracementRatio,
      expectedMove,
      lookbackCandles: LOOKBACK_CANDLES,
      trendSlopePerCandle: slope,
      extremeAt: recent[TREND_CANDLES - 1].end,
    };
  }
  return null;
}

module.exports = { detectPullback };
