'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChainlinkPriceFeed, parseClosedKlines } = require('./chainlink-price-feed');

const NOW = Math.floor(1_700_000_000_000 / (15 * 60_000)) * (15 * 60_000);

function row(start, open = 100, close = 101, volume = 12, buyVolume = 8) {
  return [
    start,
    String(open),
    String(Math.max(open, close) + 1),
    String(Math.min(open, close) - 1),
    String(close),
    String(volume),
    start + 60_000 - 1,
    String(volume * 100),
    '42',
    String(buyVolume),
    String(buyVolume * 100),
  ];
}

test('Binance parser retains volume fields and filters unfinished bars', () => {
  const candles = parseClosedKlines([
    row(NOW - 120_000),
    row(NOW - 60_000, 101, 102, 20, 13),
    row(NOW, 102, 103, 99, 50),
  ], 60_000, NOW, 'TEST');

  assert.equal(candles.length, 2);
  assert.equal(candles[1].volume, 20);
  assert.equal(candles[1].quoteVolume, 2000);
  assert.equal(candles[1].tradeCount, 42);
  assert.equal(candles[1].takerBuyBaseVolume, 13);
  assert.equal(candles[1].takerBuyQuoteVolume, 1300);
  assert.equal(candles[1].source, 'TEST');
});

test('15-minute history loads the EMA200+window and exposes closed candles', async () => {
  const interval = 15 * 60_000;
  const starts = Array.from({ length: 210 }, (_, index) => NOW - (210 - index) * interval);
  const feed = new ChainlinkPriceFeed({
    now: () => NOW,
    fetchImpl: async url => {
      assert.match(url, /interval=15m&limit=250/);
      return { ok: true, json: async () => starts.map((start, i) => row(start, 100 + i, 100 + i + .5)) };
    },
  });

  await feed.loadHistoricalFifteenMinuteCandles();

  const candles = feed.getHistoricalFifteenMinuteCandles();
  assert.equal(feed.fifteenMinuteHistoryStatus, 'ready');
  assert.equal(candles.length, 210);
  assert.equal(candles.at(-1).volume, 12);
  assert.equal(candles.at(-1).end, NOW);
});

