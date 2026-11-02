'use strict';

const { ProbabilityBot, probabilityUp } = require('./probability-bot');
const { METHOD: SIGNAL_METHOD } = require('./macd-signal');

const DEFAULT_SETTINGS = Object.freeze({
  openingDelaySeconds: 0,
  minimumNetEdge: 0.05,
  lowPriceThreshold: 0.25,
  lowPriceMinimumNetEdge: 0.10,
  volatilityMultiplier: 1,
  sharesPerSignal: 100,
  sideMode: 'pullback',
});

const MIN_CLOSED_WINDOWS = 15;
const MAX_CLOSED_WINDOWS = 15;
const TAKER_FEE_RATE = 0.07;
const CANDIDATES = Object.freeze([
  { openingDelaySeconds: 0, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'pullback' },
  { openingDelaySeconds: 0, minimumNetEdge: 0.07, lowPriceMinimumNetEdge: 0.12, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'pullback' },
  { openingDelaySeconds: 0, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 0.9, sharesPerSignal: 100, sideMode: 'pullback' },
  { openingDelaySeconds: 0, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1.1, sharesPerSignal: 100, sideMode: 'pullback' },
  { openingDelaySeconds: 0, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 50, sideMode: 'pullback' },
]);

function simulateWindow(windowSamples, settings) {
  const samples = [...windowSamples].sort((a, b) => a.ts - b.ts);
  if (samples.length < 20) return null;
  let now = samples[0].ts;
  const bot = new ProbabilityBot({
    now: () => now, strategySettings: settings,
    priceFeed: { start() {} },
  });
  const start = samples[0].windowStart ?? Math.floor(now / 300_000) * 300_000;
  bot.market = { id: 'replay', start, end: start + 300_000, tokens: { UP: 'u', DOWN: 'd' } };
  bot.beginMarketWindow();
  const ending = samples[samples.length - 1];
  let tradeCount = 0;
  for (const sample of samples) {
    now = sample.ts;
    bot.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => [
      side, { ...structuredClone(sample.quotes?.[side] ?? {}), updatedAt: now },
    ]));
    bot.processPositionExits(now);
    bot.applyPullbackSignal({
      side: sample.pullback?.side, method: SIGNAL_METHOD,
      signalSource: 'CLOSED_CANDLE', signalAt: now, signalReason: 'REPLAY_MACD',
    });
    bot.processOppositeSignalExits(now);
    if (!Number.isFinite(sample.secondsSinceOpen)
      || sample.secondsSinceOpen < settings.openingDelaySeconds
      || !Number.isFinite(sample.referencePrice)
      || !Number.isFinite(sample.spotPrice)
      || !Number.isFinite(sample.volatility5m)
      || !Number.isFinite(sample.secondsRemaining)
      || sample.secondsRemaining <= 0) continue;

    bot.probabilityUp = probabilityUp({
      openPrice: sample.referencePrice,
      spotPrice: sample.spotPrice,
      secondsRemaining: sample.secondsRemaining,
      volatility5m: sample.volatility5m * settings.volatilityMultiplier,
    });
    if (!Number.isFinite(bot.probabilityUp)) continue;
    bot.edges = bot.calculateEdges();
    const previousSequence = bot.entrySequence;
    bot.processSignals(now);
    if (bot.entrySequence > previousSequence) tradeCount++;
  }
  for (const trade of bot.trades.filter(t => t.status === 'OPEN')) {
    const bid = ending.quotes?.[trade.side]?.bestBid;
    if (!Number.isFinite(bid)) return null;
    bot.closeTrade(trade, bid, bid * trade.shares, 'WINDOW_PRICE_EXIT',
      'Replay final own-side mark', now, bid);
  }
  return {
    pnl: bot.trades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0),
    trades: tradeCount, finalCash: bot.cash,
  };
}

function scoreWindows(windows, settings) {
  const results = windows.map(window => simulateWindow(window.samples, settings)).filter(Boolean);
  if (!results.length) return null;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const result of results) {
    equity += result.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    windows: results.length,
    totalPnl: equity,
    averagePnlPerWindow: equity / results.length,
    maxDrawdown,
    tradeCount: results.reduce((sum, result) => sum + result.trades, 0),
  };
}

function choosePaperSettings(windows, currentSettings = DEFAULT_SETTINGS) {
  const chronological = [...windows]
    .map(window => ({
      ...window,
      samples: Array.isArray(window.samples)
        ? window.samples.filter(sample => sample.pullback?.method === SIGNAL_METHOD)
        : [],
    }))
    .filter(window => window.samples.length >= 20)
    .sort((a, b) => a.windowStart - b.windowStart)
    .slice(-MAX_CLOSED_WINDOWS);
  if (chronological.length < MIN_CLOSED_WINDOWS) {
    return { applied: false, reason: 'INSUFFICIENT_HISTORY', windows: chronological.length, settings: currentSettings };
  }

  const split = Math.floor(chronological.length * 0.7);
  const training = chronological.slice(0, split);
  const holdout = chronological.slice(split);
  const baseline = scoreWindows(holdout, currentSettings);
  if (!baseline || holdout.length < 5) {
    return { applied: false, reason: 'INSUFFICIENT_HOLDOUT', windows: chronological.length, settings: currentSettings };
  }

  const candidates = CANDIDATES
    .map(settings => ({
      settings: { ...DEFAULT_SETTINGS, ...settings },
      training: scoreWindows(training, settings),
    }))
    .filter(candidate => candidate.training)
    .sort((a, b) => b.training.averagePnlPerWindow - a.training.averagePnlPerWindow);

  for (const candidate of candidates) {
    const holdoutScore = scoreWindows(holdout, candidate.settings);
    if (!holdoutScore || holdoutScore.tradeCount < 10) continue;
    const minImprovement = Math.max(0.01, Math.abs(baseline.averagePnlPerWindow) * 0.05);
    if (holdoutScore.averagePnlPerWindow <= baseline.averagePnlPerWindow + minImprovement) continue;
    if (holdoutScore.maxDrawdown > baseline.maxDrawdown * 1.02 + 1) continue;
    return {
      applied: true,
      reason: 'HOLDOUT_IMPROVEMENT',
      windows: chronological.length,
      baseline,
      selected: holdoutScore,
      settings: candidate.settings,
    };
  }
  return {
    applied: false,
    reason: 'NO_HOLDOUT_IMPROVEMENT',
    windows: chronological.length,
    baseline,
    settings: currentSettings,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MIN_CLOSED_WINDOWS,
  choosePaperSettings,
  scoreWindows,
  simulateWindow,
};
