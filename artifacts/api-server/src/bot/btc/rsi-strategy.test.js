'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, START } = require('./window-test-fixture.cjs');
const { METHOD: SIGNAL_METHOD } = require('./technical-signal');
const { METHOD: RSI_METHOD } = require('./rsi-signal');

function technicalSignal(side, setup = 'FALLBACK_SCORE', confirmed = false) {
  return {
    method: SIGNAL_METHOD,
    timeframe: '5m',
    status: 'READY',
    side,
    setup,
    confirmed,
    regime: setup === 'RANGE_MEAN_REVERSION' ? 'RANGE' : 'MIXED',
    score: side === 'UP' ? 1 : -1,
    signalAt: START,
    reason: `${setup} selected ${side}.`,
    indicators: { volume: { signalAt: START } },
  };
}

test('fallback side drives scheduled 50-share entries without relying on RSI extremes', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('DOWN'));
  bot.quotes.DOWN = bot.quote({
    bids: [{ price: .49, size: 5000 }],
    asks: [{ price: .5, size: 5000 }],
  }, at(10));
  bot.processSignals(at(10));

  assert.equal(bot.activeSide, 'DOWN');
  assert.equal(bot.trades.length, 1);
  assert.equal(bot.trades[0].side, 'DOWN');
  assert.equal(bot.trades[0].shares, 50);
  assert.equal(bot.trades[0].entryKind, 'SCHEDULED_SIGNAL');
  assert.equal(bot.windowDecision.status, 'FALLBACK');
});

test('a new signal changes future entries but does not close an existing position', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP', 'TREND_CONTINUATION_PULLBACK', true));
  bot.processSignals(at(10));
  const original = bot.trades[0];

  bot.applyTechnicalSignal(technicalSignal('DOWN', 'RANGE_MEAN_REVERSION', true));
  bot.processSignals(at(20));

  assert.equal(original.status, 'OPEN');
  assert.equal(bot.trades.length, 2);
  const opposite = bot.trades.find(trade => trade.side === 'DOWN');
  assert.ok(opposite);
  assert.equal(opposite.shares, 50);
});

test('stale signal data blocks entries even when the previous side is retained', () => {
  const { bot, at } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  bot.applyTechnicalSignal({
    method: SIGNAL_METHOD,
    status: 'STALE',
    side: null,
    signalAt: START,
    reason: 'Latest closed candle is stale.',
  });
  bot.processSignals(at(10));

  assert.equal(bot.activeSide, 'UP');
  assert.equal(bot.trades.length, 0);
  assert.equal(bot.windowDecision.status, 'STALE');
});

test('hybrid strategy exposes its setup while preserving sizing, cadence, and exits', () => {
  const { bot } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP', 'TREND_CONTINUATION_PULLBACK', true));
  const state = bot.snapshot();

  assert.equal(state.strategy.sideMode, SIGNAL_METHOD);
  assert.match(state.strategy.signalPersistence, /fallback score selects UP or DOWN/);
  assert.match(state.strategy.model, /Stoch RSI/);
  assert.equal(state.strategy.sharesPerSignal, 50);
  assert.equal(state.strategy.entryIntervalSeconds, 10);
  assert.equal(state.strategy.lastEntrySeconds, 290);
  assert.equal(state.strategy.takeProfitBid, .99);
  assert.equal(state.strategy.stopLossBid, .01);
  assert.equal(state.technicalSignal.side, 'UP');
  assert.equal(state.technicalSignal.setup, 'TREND_CONTINUATION_PULLBACK');
  assert.equal(state.windowDecision.status, 'LOCKED');
  assert.equal(state.probability, null);
});

test('learning samples record the hybrid decision while retaining RSI telemetry', async () => {
  const { bot, at } = fixture();
  let saved;
  bot.learningStore = {
    recordEvent: async () => {},
    recordSample: async sample => { saved = sample; },
  };
  bot.latestPrice = 95_000;
  bot.applyTechnicalSignal(technicalSignal('DOWN', 'FALLBACK_SCORE'));
  bot.rsi = {
    method: RSI_METHOD,
    timeframe: '5m',
    period: 14,
    status: 'READY',
    value: 52,
  };
  bot.pullback = {
    method: SIGNAL_METHOD,
    timeframe: '5m',
    side: 'DOWN',
    signalSide: 'DOWN',
    setup: 'FALLBACK_SCORE',
    confirmed: false,
  };
  await bot.captureLearningSample(at(15));
  await bot.persistenceQueue;

  assert.equal(saved.technicalSignal.method, SIGNAL_METHOD);
  assert.equal(saved.technicalSignal.side, 'DOWN');
  assert.equal(saved.technicalSignal.setup, 'FALLBACK_SCORE');
  assert.equal(saved.rsi.value, 52);
  assert.equal(saved.pullback.method, SIGNAL_METHOD);
  assert.equal(saved.macd, undefined);
});

test('signal remains paper-only and does not enable probability-based selection', () => {
  const { bot } = fixture();
  bot.applyTechnicalSignal(technicalSignal('UP'));
  const state = bot.snapshot();
  assert.equal(state.mode, 'PAPER ONLY');
  assert.equal(state.strategy.probabilityModelEnabled, false);
  assert.equal(state.strategy.reversalsEnabled, false);
});
