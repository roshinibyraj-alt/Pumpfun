'use strict';

const METHOD = 'ema-stochrsi-range-divergence-v1';
const FIVE_MINUTES = 5 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_MINUTE = 60_000;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const EMA_REGIME = 200;
const RSI_STOCH = 14;
const RSI_DIVERGENCE = 7;
const STOCH_LOOKBACK = 14;
const BB_PERIOD = 20;
const ATR_PERIOD = 14;
const MIN_5M_HISTORY = 40;
const MIN_15M_HISTORY = 205;
const MINUTE_VOLUME_LOOKBACK = 20;
const VOLUME_SPIKE_MULTIPLIER = 1.5;
const VOLUME_IMBALANCE_THRESHOLD = 0.6;
const PULLBACK_ATR_TOLERANCE = 0.25;
const DIVERGENCE_ATR_TOLERANCE = 0.1;
const DIVERGENCE_RSI_TOLERANCE = 2;
const FLAT_EMA_ATR_TOLERANCE = 0.35;
const BOLLINGER_PARALLEL_WIDTH_TOLERANCE = 0.15;
const BOLLINGER_PARALLEL_SLOPE_TOLERANCE = 0.05;

function validNumber(value) {
  return value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
}

function closedContiguousCandles(input, intervalMs, now) {
  const sorted = (Array.isArray(input) ? input : [])
    .filter(candle => {
      const start = Number(candle?.start);
      const end = Number(candle?.end);
      return Number.isFinite(start) && Number.isFinite(end)
        && end - start === intervalMs && end <= now
        && ['open', 'high', 'low', 'close'].every(key =>
          validNumber(candle[key]) && Number(candle[key]) > 0);
    })
    .map(candle => ({
      ...candle,
      start: Number(candle.start),
      end: Number(candle.end),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: validNumber(candle.volume) ? Number(candle.volume) : null,
      takerBuyBaseVolume: validNumber(candle.takerBuyBaseVolume)
        ? Number(candle.takerBuyBaseVolume) : null,
    }))
    .sort((a, b) => a.end - b.end)
    .filter((candle, index, all) => index === 0 || candle.end !== all[index - 1].end);

  if (!sorted.length) return [];
  let first = sorted.length - 1;
  while (first > 0 && sorted[first - 1].end === sorted[first].start) first--;
  return sorted.slice(first);
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function emaSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length < period) return output;
  const seed = mean(values.slice(0, period));
  if (!Number.isFinite(seed)) return output;
  output[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index++) {
    if (!Number.isFinite(values[index]) || !Number.isFinite(output[index - 1])) continue;
    output[index] = (values[index] - output[index - 1]) * multiplier + output[index - 1];
  }
  return output;
}

function rsiSeries(values, period) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let averageGain = mean(changes.slice(0, period).map(change => Math.max(0, change)));
  let averageLoss = mean(changes.slice(0, period).map(change => Math.max(0, -change)));
  const toRsi = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;
    const strength = averageGain / averageLoss;
    return 100 - 100 / (1 + strength);
  };
  output[period] = toRsi();
  for (let index = period + 1; index < values.length; index++) {
    const change = changes[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    output[index] = toRsi();
  }
  return output;
}

function stochasticRsi(values, rsiPeriod = RSI_STOCH, lookback = STOCH_LOOKBACK) {
  const rsi = rsiSeries(values, rsiPeriod);
  const raw = Array(values.length).fill(null);
  for (let index = 0; index < rsi.length; index++) {
    const window = rsi.slice(index - lookback + 1, index + 1);
    if (window.length !== lookback || !window.every(Number.isFinite)) continue;
    const low = Math.min(...window);
    const high = Math.max(...window);
    raw[index] = high === low ? 50 : ((rsi[index] - low) / (high - low)) * 100;
  }
  const k = movingAverageSeries(raw, 3);
  const d = movingAverageSeries(k, 3);
  return { rsi, raw, k, d };
}

function movingAverageSeries(values, period) {
  const output = Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index++) {
    const window = values.slice(index - period + 1, index + 1);
    if (window.length === period && window.every(Number.isFinite)) output[index] = mean(window);
  }
  return output;
}

function atrSeries(candles, period = ATR_PERIOD) {
  const ranges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close;
    return Math.max(
      candle.high - candle.low,
      Number.isFinite(previousClose) ? Math.abs(candle.high - previousClose) : 0,
      Number.isFinite(previousClose) ? Math.abs(candle.low - previousClose) : 0,
    );
  });
  const output = Array(candles.length).fill(null);
  if (ranges.length < period) return output;
  output[period - 1] = mean(ranges.slice(0, period));
  for (let index = period; index < ranges.length; index++) {
    output[index] = (output[index - 1] * (period - 1) + ranges[index]) / period;
  }
  return output;
}

function bollingerSeries(values, period = BB_PERIOD, multiplier = 2) {
  return values.map((_, index) => {
    const window = values.slice(index - period + 1, index + 1);
    if (window.length !== period || !window.every(Number.isFinite)) return null;
    const middle = mean(window);
    const variance = mean(window.map(value => (value - middle) ** 2));
    const deviation = Math.sqrt(variance);
    return { middle, upper: middle + multiplier * deviation, lower: middle - multiplier * deviation };
  });
}

function rollingVwap(candles, period = BB_PERIOD) {
  const output = Array(candles.length).fill(null);
  for (let index = period - 1; index < candles.length; index++) {
    const window = candles.slice(index - period + 1, index + 1);
    if (window.some(candle => !Number.isFinite(candle.volume) || candle.volume <= 0)) continue;
    const totalVolume = window.reduce((sum, candle) => sum + candle.volume, 0);
    if (totalVolume <= 0) continue;
    output[index] = window.reduce((sum, candle) =>
      sum + ((candle.high + candle.low + candle.close) / 3) * candle.volume, 0) / totalVolume;
  }
  return output;
}

function volumeFlow(minuteCandles, now) {
  const candles = closedContiguousCandles(minuteCandles, ONE_MINUTE, now);
  const last = candles.at(-1);
  const expectedEnd = Math.floor(now / ONE_MINUTE) * ONE_MINUTE;
  if (!last || last.end !== expectedEnd || candles.length < MINUTE_VOLUME_LOOKBACK + 3) {
    return { status: 'WAITING', spike: false, direction: null, ratio: null, buyShare: null };
  }
  const recent = candles.slice(-3);
  const baseline = candles.slice(-(MINUTE_VOLUME_LOOKBACK + 3), -3);
  if (recent.some(candle => !Number.isFinite(candle.volume) || candle.volume <= 0
    || !Number.isFinite(candle.takerBuyBaseVolume))
  ) {
    return { status: 'WAITING', spike: false, direction: null, ratio: null, buyShare: null };
  }
  const recentVolume = recent.reduce((sum, candle) => sum + candle.volume, 0);
  const baselineAverage = mean(baseline.map(candle => candle.volume));
  if (!Number.isFinite(baselineAverage) || baselineAverage <= 0) {
    return { status: 'WAITING', spike: false, direction: null, ratio: null, buyShare: null };
  }
  const ratio = recentVolume / (baselineAverage * recent.length);
  const buyVolume = recent.reduce((sum, candle) => sum + candle.takerBuyBaseVolume, 0);
  const buyShare = buyVolume / recentVolume;
  const spike = ratio >= VOLUME_SPIKE_MULTIPLIER;
  const direction = spike && buyShare >= VOLUME_IMBALANCE_THRESHOLD ? 'UP'
    : spike && buyShare <= 1 - VOLUME_IMBALANCE_THRESHOLD ? 'DOWN'
      : null;
  return {
    status: 'READY',
    spike,
    direction,
    ratio,
    buyShare,
    recentMinutes: recent.length,
    signalAt: last.end,
  };
}

function pivotPoints(candles, rsi, type, left = 2, right = 2) {
  const start = Math.max(left, candles.length - 60);
  const end = candles.length - right;
  const points = [];
  for (let index = start; index < end; index++) {
    if (!Number.isFinite(rsi[index])) continue;
    const value = type === 'low' ? candles[index].low : candles[index].high;
    const neighbors = [
      ...candles.slice(index - left, index),
      ...candles.slice(index + 1, index + right + 1),
    ].map(candle => type === 'low' ? candle.low : candle.high);
    const isPivot = type === 'low'
      ? neighbors.every(neighbor => value < neighbor)
      : neighbors.every(neighbor => value > neighbor);
    if (isPivot) points.push({ index, price: value, rsi: rsi[index] });
  }
  return points.slice(-2);
}

function detectDivergence(candles, rsi, atr) {
  const lows = pivotPoints(candles, rsi, 'low');
  const highs = pivotPoints(candles, rsi, 'high');
  const [previousLow, latestLow] = lows;
  const [previousHigh, latestHigh] = highs;
  const bullish = Boolean(previousLow && latestLow
    && latestLow.price <= previousLow.price - atr * DIVERGENCE_ATR_TOLERANCE
    && latestLow.rsi >= previousLow.rsi + DIVERGENCE_RSI_TOLERANCE);
  const bearish = Boolean(previousHigh && latestHigh
    && latestHigh.price >= previousHigh.price + atr * DIVERGENCE_ATR_TOLERANCE
    && latestHigh.rsi <= previousHigh.rsi - DIVERGENCE_RSI_TOLERANCE);
  return { bullish, bearish, lows, highs };
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sign(value, epsilon = 1e-10) {
  if (!Number.isFinite(value) || Math.abs(value) <= epsilon) return 0;
  return value > 0 ? 1 : -1;
}

function chooseFallbackSide({ price15m, ema200, ema200Slope, previousSide, last5m, last15m, last1m }) {
  const priceTrend = sign(price15m - ema200);
  const slopeTrend = sign(ema200Slope);
  if (priceTrend > 0 && slopeTrend > 0) {
    return { side: 'UP', tieBreak: '15M_EMA200_TREND' };
  }
  if (priceTrend < 0 && slopeTrend < 0) {
    return { side: 'DOWN', tieBreak: '15M_EMA200_TREND' };
  }
  if (last5m.close !== last5m.open) {
    return { side: last5m.close > last5m.open ? 'UP' : 'DOWN', tieBreak: 'LAST_5M_CANDLE' };
  }
  if (previousSide === 'UP' || previousSide === 'DOWN') {
    return { side: previousSide, tieBreak: 'PREVIOUS_SIDE' };
  }
  if (last15m.close !== last15m.open) {
    return { side: last15m.close > last15m.open ? 'UP' : 'DOWN', tieBreak: 'LAST_15M_CANDLE' };
  }
  if (last1m && last1m.close !== last1m.open) {
    return { side: last1m.close > last1m.open ? 'UP' : 'DOWN', tieBreak: 'LAST_1M_CANDLE' };
  }
  return { side: 'UP', tieBreak: 'NEUTRAL_DEFAULT_UP' };
}

function selectScenarioSignal({
  trendSignalUp,
  trendSignalDown,
  rangeSignalUp,
  rangeSignalDown,
  fallbackSide,
  fallbackRule,
  confluenceName,
  targetPrice,
  targetLabel,
}) {
  if (trendSignalUp || trendSignalDown) {
    const side = trendSignalUp ? 'UP' : 'DOWN';
    return {
      side,
      setup: 'TREND_CONTINUATION_PULLBACK',
      confirmed: true,
      reason: `Trend ${side}: 5m EMA alignment and 15m EMA200 agree; price pulled back to ${confluenceName}, Stoch RSI crossed from its extreme, and signed volume confirmed.`,
      targetPrice: null,
      targetLabel: null,
    };
  }
  if (rangeSignalUp || rangeSignalDown) {
    const side = rangeSignalUp ? 'UP' : 'DOWN';
    return {
      side,
      setup: 'RANGE_MEAN_REVERSION',
      confirmed: true,
      reason: side === 'UP'
        ? 'Range UP: flat 15m EMA200, parallel Bollinger Bands, lower-band touch, and confirmed bullish RSI(7) divergence.'
        : 'Range DOWN: flat 15m EMA200, parallel Bollinger Bands, upper-band touch, and confirmed bearish RSI(7) divergence.',
      targetPrice,
      targetLabel,
    };
  }
  return {
    side: fallbackSide,
    setup: 'DIRECTIONAL_FALLBACK',
    confirmed: false,
    fallbackRule,
    reason: `No named setup confirmed; ${fallbackRule} selected ${fallbackSide}.`,
    targetPrice: null,
    targetLabel: null,
  };
}

function detectTechnicalSignal({
  candles5m,
  candles15m,
  candles1m,
  now,
  previousSide = null,
}) {
  const base = {
    method: METHOD,
    timeframe: '5m',
    status: 'WAITING_HISTORY',
    side: null,
    setup: null,
    confirmed: false,
    signalAt: null,
    score: null,
    reason: 'Waiting for sufficient closed-candle history.',
  };
  if (!Number.isFinite(now)) {
    return { ...base, status: 'INVALID_HISTORY', reason: 'Current time is unavailable.' };
  }

  const five = closedContiguousCandles(candles5m, FIVE_MINUTES, now);
  const fifteen = closedContiguousCandles(candles15m, FIFTEEN_MINUTES, now);
  const minute = closedContiguousCandles(candles1m, ONE_MINUTE, now);
  const latest5m = five.at(-1);
  const latest15m = fifteen.at(-1);
  const expected5mEnd = Math.floor(now / FIVE_MINUTES) * FIVE_MINUTES;
  const expected15mEnd = Math.floor(now / FIFTEEN_MINUTES) * FIFTEEN_MINUTES;
  if (!latest5m || latest5m.end !== expected5mEnd) {
    return {
      ...base, status: 'STALE', signalAt: latest5m?.end ?? null,
      reason: 'The latest closed five-minute candle is missing or stale.',
    };
  }
  if (!latest15m || expected15mEnd - latest15m.end > FIFTEEN_MINUTES) {
    return {
      ...base, status: 'STALE', signalAt: latest5m.end,
      reason: 'The latest closed fifteen-minute candle is missing or stale.',
    };
  }
  if (five.length < MIN_5M_HISTORY || fifteen.length < MIN_15M_HISTORY) {
    return {
      ...base, status: 'WAITING_HISTORY', signalAt: latest5m.end,
      reason: `Need ${MIN_5M_HISTORY} contiguous 5m and ${MIN_15M_HISTORY} contiguous 15m candles; found ${five.length} and ${fifteen.length}.`,
    };
  }

  const closes5m = five.map(candle => candle.close);
  const closes15m = fifteen.map(candle => candle.close);
  const ema9 = emaSeries(closes5m, EMA_FAST);
  const ema21 = emaSeries(closes5m, EMA_SLOW);
  const ema200 = emaSeries(closes15m, EMA_REGIME);
  const atr5 = atrSeries(five);
  const atr15 = atrSeries(fifteen);
  const rsi7 = rsiSeries(closes5m, RSI_DIVERGENCE);
  const stoch = stochasticRsi(closes5m);
  const bands = bollingerSeries(closes5m);
  const vwap = rollingVwap(five);
  const last = five.length - 1;
  const prior = last - 1;
  const ema15Last = fifteen.length - 1;
  const slopeBack = ema15Last - 4;
  const latestBands = bands[last];
  const olderBands = bands[last - 4];
  const latestVwap = vwap[last];
  const latestAtr5 = atr5[last];
  const latestAtr15 = atr15[ema15Last];
  const ema200Slope = ema200[ema15Last] - ema200[slopeBack];
  const latestStochK = stoch.k[last];
  const previousStochK = stoch.k[prior];
  const flow = volumeFlow(minute, now);
  const latest1m = minute.at(-1) ?? null;

  if (![ema9[last], ema21[last], ema200[ema15Last], ema200[slopeBack],
    latestAtr5, latestAtr15, latestBands?.middle, latestVwap, latestStochK,
    previousStochK, rsi7[last]].every(Number.isFinite)) {
    return {
      ...base, status: 'WAITING_HISTORY', signalAt: latest5m.end,
      reason: 'Closed candles do not yet contain enough valid values for the indicators.',
    };
  }

  const price5m = five[last].close;
  const price15m = latest15m.close;
  const trendUp = price5m > ema9[last] && price5m > ema21[last]
    && ema9[last] > ema21[last] && price15m > ema200[ema15Last] && ema200Slope > 0;
  const trendDown = price5m < ema9[last] && price5m < ema21[last]
    && ema9[last] < ema21[last] && price15m < ema200[ema15Last] && ema200Slope < 0;
  const pullbackTolerance = Math.max(latestAtr5 * PULLBACK_ATR_TOLERANCE, price5m * 0.0001);
  const confluenceLevels = [
    { name: 'EMA21', value: ema21[last] },
    { name: 'VWAP20', value: latestVwap },
  ];
  const touchedConfluence = confluenceLevels.find(level =>
    five[last].low <= level.value + pullbackTolerance
    && five[last].high >= level.value - pullbackTolerance);
  const pulledBackUp = Boolean(touchedConfluence && five[last].close >= touchedConfluence.value - pullbackTolerance);
  const pulledBackDown = Boolean(touchedConfluence && five[last].close <= touchedConfluence.value + pullbackTolerance);
  const stochCrossUp = previousStochK < 20 && latestStochK >= 20;
  const stochCrossDown = previousStochK > 80 && latestStochK <= 80;
  const trendSignalUp = trendUp && pulledBackUp && stochCrossUp && flow.direction === 'UP';
  const trendSignalDown = trendDown && pulledBackDown && stochCrossDown && flow.direction === 'DOWN';

  const ema200Flat = Math.abs(ema200[ema15Last] - ema200[slopeBack])
    <= Math.max(latestAtr15 * FLAT_EMA_ATR_TOLERANCE, Math.abs(ema200[ema15Last]) * 0.00005);
  const currentWidth = latestBands.upper - latestBands.lower;
  const olderWidth = olderBands ? olderBands.upper - olderBands.lower : null;
  const upperDelta = olderBands ? latestBands.upper - olderBands.upper : null;
  const lowerDelta = olderBands ? latestBands.lower - olderBands.lower : null;
  const averageWidth = Number.isFinite(olderWidth) ? (currentWidth + olderWidth) / 2 : null;
  const widthStable = Number.isFinite(averageWidth) && averageWidth > 0
    && Math.abs(currentWidth - olderWidth) <= Math.max(
      averageWidth * BOLLINGER_PARALLEL_WIDTH_TOLERANCE,
      latestAtr5 * 0.25,
    );
  const slopesSimilar = Number.isFinite(upperDelta) && Number.isFinite(lowerDelta)
    && Math.abs(upperDelta - lowerDelta) <= Math.max(
      averageWidth * BOLLINGER_PARALLEL_SLOPE_TOLERANCE,
      latestAtr5 * 0.1,
    );
  const sameSlopeDirection = Number.isFinite(upperDelta) && Number.isFinite(lowerDelta)
    && (sign(upperDelta) === sign(lowerDelta)
      || (Math.abs(upperDelta) <= latestAtr5 * 0.05 && Math.abs(lowerDelta) <= latestAtr5 * 0.05));
  const bandsParallel = Boolean(widthStable && slopesSimilar && sameSlopeDirection);
  const rangeRegime = ema200Flat && bandsParallel && !trendUp && !trendDown;
  const divergence = detectDivergence(five, rsi7, latestAtr5);
  const lowerBandTouch = five[last].low <= latestBands.lower + latestAtr5 * 0.1;
  const upperBandTouch = five[last].high >= latestBands.upper - latestAtr5 * 0.1;
  const rangeSignalUp = rangeRegime && lowerBandTouch && divergence.bullish;
  const rangeSignalDown = rangeRegime && upperBandTouch && divergence.bearish;

  const fallback = chooseFallbackSide({
    price15m,
    ema200: ema200[ema15Last],
    ema200Slope,
    previousSide,
    last5m: five[last],
    last15m: latest15m,
    last1m: latest1m,
  });

  const selection = selectScenarioSignal({
    trendSignalUp,
    trendSignalDown,
    rangeSignalUp,
    rangeSignalDown,
    fallbackSide: fallback.side,
    fallbackRule: fallback.tieBreak,
    confluenceName: touchedConfluence?.name ?? 'EMA21/VWAP',
    targetPrice: Number.isFinite(latestVwap) ? latestVwap : latestBands.middle,
    targetLabel: Number.isFinite(latestVwap) ? 'ROLLING_VWAP_20' : 'BOLLINGER_MIDDLE',
  });

  const regime = trendUp ? 'TREND_UP' : trendDown ? 'TREND_DOWN' : rangeRegime ? 'RANGE' : 'MIXED';
  return {
    ...base,
    status: 'READY',
    ...selection,
    regime,
    signalAt: latest5m.end,
    score: null,
    tieBreak: selection.setup === 'DIRECTIONAL_FALLBACK' ? fallback.tieBreak : null,
    votes: [],
    indicators: {
      price5m: round(price5m),
      price15m: round(price15m),
      ema9: round(ema9[last]),
      ema21: round(ema21[last]),
      ema200_15m: round(ema200[ema15Last]),
      ema200Slope_4bars: round(ema200Slope),
      vwap20: round(latestVwap),
      rsi7: round(rsi7[last], 2),
      stochRsiK: round(latestStochK, 2),
      stochRsiKPrevious: round(previousStochK, 2),
      bollinger: {
        upper: round(latestBands.upper),
        middle: round(latestBands.middle),
        lower: round(latestBands.lower),
        parallel: bandsParallel,
      },
      ema200Flat,
      volume: {
        status: flow.status,
        spike: flow.spike,
        direction: flow.direction,
        ratio: round(flow.ratio, 3),
        takerBuyShare: round(flow.buyShare, 3),
        signalAt: flow.signalAt ?? null,
      },
      pullbackConfluence: touchedConfluence?.name ?? null,
      divergence: {
        bullish: divergence.bullish,
        bearish: divergence.bearish,
        lowerBandTouch,
        upperBandTouch,
      },
      rangeRegime,
    },
  };
}

module.exports = {
  METHOD,
  detectTechnicalSignal,
  closedContiguousCandles,
  emaSeries,
  rsiSeries,
  stochasticRsi,
  bollingerSeries,
  rollingVwap,
  volumeFlow,
  detectDivergence,
  chooseFallbackSide,
  selectScenarioSignal,
};
