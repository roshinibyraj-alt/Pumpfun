'use strict';

function detectPullback(ticks, now, volatility5m) {
  if (!Array.isArray(ticks) || !Number.isFinite(now)
    || !Number.isFinite(volatility5m) || volatility5m <= 0) return null;
  const recent = ticks.filter(tick => Number.isFinite(tick?.ts)
    && Number.isFinite(tick?.price)
    && tick.price > 0
    && tick.ts >= now - 60_000
    && tick.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  if (recent.length < 5) return null;

  const base = recent[0];
  const latest = recent[recent.length - 1];
  const expectedMove = base.price * volatility5m * Math.sqrt(60 / 300);
  const minimumImpulse = Math.max(expectedMove * 0.6, base.price * 0.00008);
  let high = base;
  let low = base;
  for (const tick of recent.slice(1)) {
    if (tick.price > high.price) high = tick;
    if (tick.price < low.price) low = tick;
  }

  const highImpulse = high.price - base.price;
  const highRetracement = high.price - latest.price;
  if (highImpulse >= minimumImpulse
    && high.ts - base.ts >= 10_000
    && now - high.ts >= 2_000
    && now - high.ts <= 45_000
    && highRetracement >= highImpulse * 0.35) {
    return {
      side: 'DOWN',
      regime: 'PULLBACK_AFTER_RISE',
      impulseMove: highImpulse,
      retracementMove: highRetracement,
      retracementRatio: highRetracement / highImpulse,
      expectedMove,
      extremeAt: high.ts,
    };
  }

  const lowImpulse = base.price - low.price;
  const lowRetracement = latest.price - low.price;
  if (lowImpulse >= minimumImpulse
    && low.ts - base.ts >= 10_000
    && now - low.ts >= 2_000
    && now - low.ts <= 45_000
    && lowRetracement >= lowImpulse * 0.35) {
    return {
      side: 'UP',
      regime: 'PULLBACK_AFTER_FALL',
      impulseMove: lowImpulse,
      retracementMove: lowRetracement,
      retracementRatio: lowRetracement / lowImpulse,
      expectedMove,
      extremeAt: low.ts,
    };
  }
  return null;
}

module.exports = { detectPullback };
