'use strict';
const { ProbabilityBot } = require('./probability-bot');
const START = 1_800_000_000_000;
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
  return { bot, at, start: START };
}
module.exports = { START, fixture };
