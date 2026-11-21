'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BinanceMultiTimeframeFeed } = require('./binance-multitimeframe-feed.cjs');

test('a 4h candle failure does not block ready 15m and 1h signal inputs', async () => {
  const feed = new BinanceMultiTimeframeFeed({
    now: () => 10_000_000,
    fetchImpl: async url => {
      const interval = new URL(url).searchParams.get('interval');
      if (interval === '4h') throw new Error('optional 4h request failed');
      const duration = interval === '15m' ? 15 * 60_000 : 60 * 60_000;
      return {
        ok: true,
        async json() {
          return [[0, '100', '101', '99', '100.5', '1', String(duration - 1)]];
        },
      };
    },
  });

  const refreshed = await feed.refresh();
  const snapshot = feed.snapshot();

  assert.equal(refreshed, true);
  assert.equal(snapshot.status, 'READY');
  assert.ok(snapshot.lastUpdatedAt);
  assert.match(snapshot.contextError, /optional 4h request failed/);
  assert.equal(snapshot.candles['15m'].length, 1);
  assert.equal(snapshot.candles['1h'].length, 1);
});
