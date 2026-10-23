'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRegime } = require('./regime-detector');

function ticksFrom(prices, now) {
  return prices.map((price, index) => ({ ts: now - 90_000 + index * 10_000, price }));
}

test('classifies a sustained BTC move as trending', () => {
  const now = 1_800_000;
  const ticks = ticksFrom(Array.from({ length: 10 }, (_, i) => 100 + i * 0.08), now);
  const result = classifyRegime(ticks, now);
  assert.equal(result.state, 'TRENDING');
  assert.ok(result.efficiency > 0.9);
  assert.equal(result.reversals, 0);
});

test('classifies repeated reversals with little net progress as choppy', () => {
  const now = 1_800_000;
  const ticks = ticksFrom([100, 100.1, 99.9, 100.1, 99.9, 100.1, 99.9, 100.1, 99.9, 100], now);
  const result = classifyRegime(ticks, now);
  assert.equal(result.state, 'CHOPPY');
  assert.ok(result.reversals >= 3);
  assert.ok(result.efficiency < 0.22);
});

test('returns unknown for stale prices or too little history', () => {
  const now = 1_800_000;
  assert.equal(classifyRegime([{ ts: now - 20_000, price: 100 }], now).state, 'UNKNOWN');
  const shortHistory = ticksFrom([100, 100.1, 100.2, 100.3], now).slice(-4);
  assert.equal(classifyRegime(shortHistory, now).state, 'UNKNOWN');
});

test('classifies a nearly flat market as choppy even without large reversals', () => {
  const now = 1_800_000;
  const ticks = ticksFrom(Array.from({ length: 10 }, (_, i) => 100 + (i % 2) * 0.005), now);
  assert.equal(classifyRegime(ticks, now).state, 'CHOPPY');
});
