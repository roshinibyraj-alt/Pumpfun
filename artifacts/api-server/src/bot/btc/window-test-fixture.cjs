'use strict';
const { ProbabilityBot } = require('./probability-bot');
const { METHOD } = require('./macd-signal');
const { METHOD: RSI_METHOD, RSI_PERIOD, OVERBOUGHT, OVERSOLD } = require('./rsi-signal');
const CANDLE_MS = 5 * 60_000;
const START = 1_800_000_000_000;
function closedCandleSignal(classification = 'SHRINKING_RED', start = START) {
  const bar = {
    SOLID_RED: { histogram: -2, previousHistogram: -1, side: 'DOWN' },
    SHRINKING_RED: { histogram: -1, previousHistogram: -2, side: 'UP' },
    SOLID_GREEN: { histogram: 2, previousHistogram: 1, side: 'UP' },
    SHRINKING_GREEN: { histogram: 1, previousHistogram: 2, side: 'DOWN' },
    NEUTRAL: { histogram: 1, previousHistogram: 1, side: null },
  }[classification];
  return {
    method: METHOD, timeframe: '5m', status: 'READY', signalAt: start,
    side: bar.side, classification, latestHistogram: bar.histogram,
    previousHistogram: bar.previousHistogram,
    chart: { bars: [{
      start: start - CANDLE_MS, end: start,
      histogram: bar.histogram, previousHistogram: bar.previousHistogram,
      classification, side: bar.side,
    }] },
  };
}
function rsiSignal(value = 20, signalAt = START) {
  const side = value < OVERSOLD ? 'UP' : value > OVERBOUGHT ? 'DOWN' : null;
  return {
    method: RSI_METHOD, timeframe: '5m', status: 'READY', period: RSI_PERIOD,
    oversold: OVERSOLD, overbought: OVERBOUGHT, value,
    bucket: side === 'UP' ? 'OVERSOLD' : side === 'DOWN' ? 'OVERBOUGHT' : 'NEUTRAL',
    side, signalAt, history: [], lastExtreme: null, momentumSide: null,
  };
}
function fixture(options = {}) {
  let now = START + 10_000;
  const bot = new ProbabilityBot({
    now: () => now, priceFeed: { start() {}, snapshot() { return {}; } }, ...options,
  });
  bot.market = { id: 'm', start: START, end: START + 300_000, tokens: { UP: 'u', DOWN: 'd' } };
  bot.beginMarketWindow();
  function at(seconds, bid = .4, ask = .5) {
    now = START + seconds * 1000;
    bot.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => [
      side, bot.quote({ bids: [{ price: bid, size: 5000 }], asks: [{ price: ask, size: 5000 }] }, now),
    ]));
    return now;
  }
  at(10);
  return { bot, at, closedCandleSignal, start: START };
}
module.exports = { START, CANDLE_MS, closedCandleSignal, rsiSignal, fixture };
