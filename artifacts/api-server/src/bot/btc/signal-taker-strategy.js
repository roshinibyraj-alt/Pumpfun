'use strict';

const STRATEGY_VERSION = 'btc-5m-candle-signal-variants-target-300-v1';
const WINDOW_MS = 5 * 60 * 1000;
const SIGNAL_SCAN_LEAD_MS = 10_000;
const SIGNAL_COMPARE_LEAD_MS = 3_000;
const MAX_REFERENCE_CANDLE_AGE_MS = 90_000;
const ENTRY_SHARES = 100;
const VARIANT_PROFIT_TARGET = 300;
const POLL_INTERVAL_MS = 500;
const MAX_QUOTE_AGE_MS = 5_000;
const DEFAULT_TAKER_FEE_RATE = 0.07;
const DEFAULT_TAKER_FEE_EXPONENT = 1;

function quoteIsFresh(quote, now, maxAgeMs = MAX_QUOTE_AGE_MS) {
  return Number.isFinite(quote?.updatedAt)
    && now >= quote.updatedAt
    && now - quote.updatedAt <= maxAgeMs;
}

function feeParameters(market, defaultRate = DEFAULT_TAKER_FEE_RATE) {
  const raw = market?.raw ?? market ?? {};
  const feesEnabled = raw.feesEnabled ?? raw.fees_enabled;
  if (feesEnabled === false || String(feesEnabled).toLowerCase() === 'false') {
    return { rate: 0, exponent: DEFAULT_TAKER_FEE_EXPONENT };
  }
  const schedule = raw.feeSchedule ?? raw.fee_schedule ?? raw.fees?.schedule ?? {};
  const rate = Number(schedule.rate ?? raw.takerFeeRate ?? raw.taker_fee_rate ?? defaultRate);
  const exponent = Number(schedule.exponent ?? raw.takerFeeExponent ?? raw.taker_fee_exponent
    ?? DEFAULT_TAKER_FEE_EXPONENT);
  return {
    rate: Number.isFinite(rate) && rate >= 0 ? rate : defaultRate,
    exponent: Number.isFinite(exponent) && exponent > 0 ? exponent : DEFAULT_TAKER_FEE_EXPONENT,
  };
}

function takerFeeAt(price, shares, parameters = {}) {
  const rate = Number(parameters.rate ?? DEFAULT_TAKER_FEE_RATE);
  const exponent = Number(parameters.exponent ?? DEFAULT_TAKER_FEE_EXPONENT);
  if (!Number.isFinite(price) || price <= 0 || price >= 1
    || !Number.isFinite(shares) || shares <= 0
    || !Number.isFinite(rate) || rate < 0
    || !Number.isFinite(exponent) || exponent <= 0) return 0;
  return rate * ((price * (1 - price)) ** exponent) * shares;
}

function estimateTakerFee(price, shares, market) {
  return takerFeeAt(price, shares, feeParameters(market));
}

function simulateTakerBuyFill(asks, requestedShares, market) {
  const remainingRequested = Number(requestedShares);
  if (!Number.isFinite(remainingRequested) || remainingRequested <= 0) return null;
  const parameters = feeParameters(market);
  const levels = (Array.isArray(asks) ? asks : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = remainingRequested;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 1e-8) break;
    const filledShares = Math.min(remaining, level.size);
    const filledCost = filledShares * level.price;
    fills.push({
      price: level.price,
      shares: filledShares,
      cost: filledCost,
      fees: takerFeeAt(level.price, filledShares, parameters),
    });
    shares += filledShares;
    cost += filledCost;
    fees += fills.at(-1).fees;
    remaining -= filledShares;
  }
  if (shares <= 1e-8) return null;
  return {
    requestedShares: remainingRequested,
    shares,
    remainingShares: Math.max(0, remaining),
    averagePrice: cost / shares,
    cost,
    fees,
    totalCost: cost + fees,
    fills,
    feeRate: parameters.rate,
    feeExponent: parameters.exponent,
  };
}

function selectClosedCandleSignal({ candles, ticks, signalAt, now }) {
  const closed = (Array.isArray(candles) ? candles : [])
    .map(candle => ({
      t: Number(candle.t),
      close: Number(candle.c ?? candle.close),
    }))
    .filter(candle => Number.isFinite(candle.t) && Number.isFinite(candle.close)
      && candle.t + 60_000 <= signalAt)
    .sort((a, b) => b.t - a.t)[0];
  if (!closed) return { status: 'WAITING_FOR_CLOSED_CANDLE', selectedSide: null };
  const candleCloseAt = closed.t + 60_000;
  if (signalAt - candleCloseAt > MAX_REFERENCE_CANDLE_AGE_MS) {
    return {
      status: 'STALE_CLOSED_CANDLE',
      selectedSide: null,
      referenceClose: closed.close,
      referenceCandleAt: closed.t,
      candleCloseAt,
    };
  }
  const eligibleTicks = (Array.isArray(ticks) ? ticks : [])
    .map(tick => ({ ts: Number(tick.ts), price: Number(tick.price) }))
    .filter(tick => Number.isFinite(tick.ts) && Number.isFinite(tick.price)
      && tick.price > 0 && tick.ts > candleCloseAt && tick.ts <= signalAt + 1_000)
    .sort((a, b) => b.ts - a.ts);
  const tick = eligibleTicks[0];
  if (!tick || now < signalAt) {
    return {
      status: 'WAITING_FOR_SIGNAL_PRICE',
      selectedSide: null,
      referenceClose: closed.close,
      referenceCandleAt: closed.t,
      candleCloseAt,
      signalAt,
    };
  }
  const selectedSide = tick.price > closed.close ? 'UP' : 'DOWN';
  return {
    status: 'SIGNAL_LATCHED',
    selectedSide,
    referenceClose: closed.close,
    referenceCandleAt: closed.t,
    candleCloseAt,
    signalPrice: tick.price,
    signalPriceAt: tick.ts,
    signalAt,
    rule: tick.price > closed.close ? 'BTC_ABOVE_PREVIOUS_1M_CLOSE' : 'BTC_AT_OR_BELOW_PREVIOUS_1M_CLOSE',
  };
}

function getWindowToScan(now) {
  const currentStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const nextStart = currentStart + WINDOW_MS;
  return nextStart - now <= SIGNAL_SCAN_LEAD_MS ? nextStart : currentStart;
}

module.exports = {
  STRATEGY_VERSION,
  WINDOW_MS,
  SIGNAL_SCAN_LEAD_MS,
  SIGNAL_COMPARE_LEAD_MS,
  MAX_REFERENCE_CANDLE_AGE_MS,
  ENTRY_SHARES,
  VARIANT_PROFIT_TARGET,
  POLL_INTERVAL_MS,
  MAX_QUOTE_AGE_MS,
  DEFAULT_TAKER_FEE_RATE,
  DEFAULT_TAKER_FEE_EXPONENT,
  quoteIsFresh,
  feeParameters,
  takerFeeAt,
  estimateTakerFee,
  simulateTakerBuyFill,
  selectClosedCandleSignal,
  getWindowToScan,
};
