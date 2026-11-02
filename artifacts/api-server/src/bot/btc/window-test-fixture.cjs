'use strict';
const { ProbabilityBot } = require('./probability-bot');
const { METHOD } = require('./macd-signal');
const START = 1_800_000_000_000;
function pair(first = 'SOLID_RED', second = 'SHRINKING_RED', start = START) {
  return { method: METHOD, status: 'READY', chart: { bars: [
    { start, end: start + 60_000, histogram: -3, classification: first },
    { start: start + 60_000, end: start + 120_000, histogram: -1, classification: second },
  ] } };
}
function fixture(options = {}) {
  let now = START + 120_000;
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
  at(120);
  return { bot, at, pair, start: START };
}
module.exports = { START, pair, fixture };
