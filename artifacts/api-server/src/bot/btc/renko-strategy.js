'use strict';

const {
  DEFAULT_TAKER_FEE_EXPONENT,
  DEFAULT_TAKER_FEE_RATE,
  feeParameters,
  takerFeeAt,
} = require('./paper-trading');

const STRATEGY_VERSION = 'btc-5m-renko-1m-opposite-signal-taker-300-tp099-resolution-v3';
const CANDLE_INTERVAL_MS = 60_000;
const RENKO_ATR_PERIOD = 14;
const RENKO_HISTORY_CANDLES = 100;
const MAX_BRICKS_PER_CANDLE = 1000;

function candleFields(candle) {
  const t = Number(candle?.t ?? candle?.start);
  const open = Number(candle?.o ?? candle?.open);
  const high = Number(candle?.h ?? candle?.high);
  const low = Number(candle?.l ?? candle?.low);
  const close = Number(candle?.c ?? candle?.close);
  if (!Number.isFinite(t) || ![open, high, low, close].every(value => Number.isFinite(value) && value > 0)
    || high < low) return null;
  return { t, end: t + CANDLE_INTERVAL_MS, open, high, low, close };
}

function combineClosedMinuteCandles({ historical = [], live = [], now = Date.now() } = {}) {
  const byStart = new Map();
  for (const candle of historical) {
    const normalized = candleFields(candle);
    if (normalized && normalized.end <= now) byStart.set(normalized.t, normalized);
  }
  // Prefer the live Chainlink-built candle when both sources contain the same minute.
  for (const candle of live) {
    const normalized = candleFields(candle);
    if (normalized && normalized.end <= now) byStart.set(normalized.t, normalized);
  }
  return [...byStart.values()].sort((a, b) => a.t - b.t);
}

function calculateAtrBrickSize(candles, period = RENKO_ATR_PERIOD) {
  const valid = (Array.isArray(candles) ? candles : [])
    .map(candleFields)
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  if (!Number.isInteger(period) || period < 1 || valid.length < period + 1) {
    return { status: 'WAITING_FOR_ATR_HISTORY', brickSize: null, atr: null, period };
  }

  const sample = valid.slice(-(period + 1));
  const ranges = [];
  for (let index = 1; index < sample.length; index++) {
    const candle = sample[index];
    const previousClose = sample[index - 1].close;
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    ));
  }
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  if (!Number.isFinite(atr) || atr <= 0) {
    return { status: 'INVALID_ATR', brickSize: null, atr: null, period };
  }
  return { status: 'READY', brickSize: atr, atr, period };
}

function appendRenkoClose(state, candle) {
  const normalized = candleFields(candle);
  if (!normalized || !state || !Number.isFinite(state.brickSize) || state.brickSize <= 0
    || normalized.t <= state.lastCandleStart) {
    return { state, bricks: [] };
  }

  const price = normalized.close;
  const size = state.brickSize;
  const bricks = [];
  let count = 0;
  const emit = color => {
    state.lastBrickClose += (color === 'GREEN' ? 1 : -1) * size;
    state.direction = color;
    state.sequence += 1;
    const brick = {
      color,
      side: color === 'GREEN' ? 'UP' : 'DOWN',
      close: state.lastBrickClose,
      candleStart: normalized.t,
      at: normalized.end,
      sequence: state.sequence,
    };
    state.lastBrick = brick;
    bricks.push(brick);
    count += 1;
  };

  while (count < MAX_BRICKS_PER_CANDLE) {
    if (!state.direction) {
      if (price >= state.lastBrickClose + size) emit('GREEN');
      else if (price <= state.lastBrickClose - size) emit('RED');
      else break;
      continue;
    }

    if (state.direction === 'GREEN') {
      if (price >= state.lastBrickClose + size) emit('GREEN');
      else if (price <= state.lastBrickClose - (2 * size)) {
        // A standard Renko reversal needs a two-box move; the first opposite
        // brick is placed one box back from the previous brick close.
        emit('RED');
      } else break;
      continue;
    }

    if (price <= state.lastBrickClose - size) emit('RED');
    else if (price >= state.lastBrickClose + (2 * size)) emit('GREEN');
    else break;
  }

  state.lastCandleStart = normalized.t;
  return { state, bricks };
}

function buildRenko(candles, brickSize) {
  const valid = (Array.isArray(candles) ? candles : [])
    .map(candleFields)
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
  if (!valid.length || !Number.isFinite(brickSize) || brickSize <= 0) {
    return { state: null, bricks: [] };
  }

  const first = valid[0];
  const state = {
    brickSize,
    direction: null,
    lastBrickClose: first.close,
    lastCandleStart: first.t,
    lastBrick: null,
    sequence: 0,
  };
  const bricks = [];
  for (const candle of valid.slice(1)) {
    const result = appendRenkoClose(state, candle);
    bricks.push(...result.bricks);
  }
  return { state, bricks };
}

function simulateTakerSellFill(bids, requestedShares, market) {
  const requested = Number(requestedShares);
  if (!Number.isFinite(requested) || requested <= 0) return null;
  const parameters = feeParameters(market);
  const levels = (Array.isArray(bids) ? bids : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
      && Number.isFinite(level.size) && level.size > 0)
    .sort((a, b) => b.price - a.price);

  let remaining = requested;
  let shares = 0;
  let grossPayout = 0;
  let fees = 0;
  const fills = [];
  for (const level of levels) {
    if (remaining <= 1e-8) break;
    const filledShares = Math.min(remaining, level.size);
    const payout = filledShares * level.price;
    const fillFees = takerFeeAt(level.price, filledShares, parameters);
    fills.push({ price: level.price, shares: filledShares, payout, fees: fillFees });
    shares += filledShares;
    grossPayout += payout;
    fees += fillFees;
    remaining -= filledShares;
  }
  if (shares <= 1e-8) return null;
  return {
    requestedShares: requested,
    shares,
    remainingShares: Math.max(0, remaining),
    averagePrice: grossPayout / shares,
    grossPayout,
    fees,
    netPayout: grossPayout - fees,
    fills,
    feeRate: parameters.rate,
    feeExponent: parameters.exponent,
  };
}

module.exports = {
  STRATEGY_VERSION,
  CANDLE_INTERVAL_MS,
  RENKO_ATR_PERIOD,
  RENKO_HISTORY_CANDLES,
  combineClosedMinuteCandles,
  calculateAtrBrickSize,
  appendRenkoClose,
  buildRenko,
  simulateTakerSellFill,
};
