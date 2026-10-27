'use strict';

function candleColor(open, close, high, low) {
  const range = Number(high) - Number(low);
  const body = Math.abs(Number(close) - Number(open));
  if (range > 0 && body / range <= 0.1) return 'DOJI';
  return Number(close) > Number(open) ? 'GREEN' : Number(close) < Number(open) ? 'RED' : 'DOJI';
}

function aggregateCompleteCandles(minuteCandles, windowMs) {
  const count = windowMs / 60_000;
  const groups = new Map();
  for (const row of minuteCandles || []) {
    const start = Math.floor(Number(row.t) / windowMs) * windowMs;
    const rows = groups.get(start) || [];
    rows.push(row);
    groups.set(start, rows);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([start, rows]) => {
    rows.sort((a, b) => a.t - b.t);
    if (rows.length !== count || rows.some((row, index) => row.t !== start + index * 60_000)) return [];
    const open = Number(rows[0].o);
    const close = Number(rows.at(-1).c);
    const high = Math.max(...rows.map(row => Number(row.h)));
    const low = Math.min(...rows.map(row => Number(row.l)));
    return [{ start, end: start + windowMs, open, close, high, low, color: candleColor(open, close, high, low) }];
  });
}

function signalForPrevious(candles) {
  if (!candles.length) return {
    side: 'UP',
    pattern: 'NO_HISTORY_DEFAULT_UP',
    fallback: true,
    reason: 'No complete BTC candle history is available; using the explicit UP fallback so this window still receives orders',
  };
  const previous = candles.at(-1);
  if (previous.color === 'GREEN') return { side: 'UP', pattern: 'PREVIOUS_GREEN', previous };
  if (previous.color === 'RED') return { side: 'DOWN', pattern: 'PREVIOUS_RED', previous };
  let red = 0;
  let green = 0;
  for (let index = candles.length - 2; index >= 0; index--) {
    if (candles[index].color === 'RED' && !green) red++;
    else if (candles[index].color === 'GREEN' && !red) green++;
    else break;
  }
  if (red >= 2) return { side: 'UP', pattern: 'DOJI_AFTER_RED_RUN', previous };
  if (green >= 2) return { side: 'DOWN', pattern: 'DOJI_AFTER_GREEN_RUN', previous };
  const priorDirection = [...candles.slice(0, -1)].reverse().find(candle => ['GREEN', 'RED'].includes(candle.color));
  if (priorDirection) return {
    side: priorDirection.color === 'GREEN' ? 'UP' : 'DOWN',
    pattern: 'DOJI_FALLBACK_LAST_DIRECTION',
    previous,
    fallbackCandle: priorDirection,
    reason: `Neutral doji; continuing the latest directional candle (${priorDirection.color})`,
  };
  return {
    side: 'UP',
    pattern: 'DOJI_NO_DIRECTION_DEFAULT_UP',
    previous,
    fallback: true,
    reason: 'No directional candle pattern is available; using the explicit UP fallback so this window still receives orders',
  };
}

module.exports = { candleColor, aggregateCompleteCandles, signalForPrevious };
