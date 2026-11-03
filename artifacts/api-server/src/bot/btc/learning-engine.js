'use strict';

const { ProbabilityBot, DEFAULT_STRATEGY_SETTINGS } = require('./probability-bot');
const { METHOD } = require('./macd-signal');

const DEFAULT_SETTINGS = DEFAULT_STRATEGY_SETTINGS;
const MIN_CLOSED_WINDOWS = 15;

// Replay exactly the fixed live execution policy; old signal-method samples are incompatible.
function simulateWindow(windowSamples) {
  const samples = [...windowSamples].filter(s => s.pullback?.method === METHOD)
    .sort((a, b) => a.ts - b.ts);
  if (samples.length < 20) return null;
  let now = samples[0].ts;
  const start = samples[0].windowStart;
  if (!Number.isFinite(start) || samples.some(s => s.windowStart !== start)) return null;
  const bot = new ProbabilityBot({ now: () => now, priceFeed: { start() {} },
    priceBandFilter: samples.some(sample => sample.entryPriceBand?.enabled === true),
    fourBarFilter: samples.some(sample => sample.windowDecision?.fourBarFilter?.enabled === true) });
  bot.market = { id: 'replay', start, end: start + 300_000, tokens: { UP: 'u', DOWN: 'd' } };
  bot.beginMarketWindow();
  let closedBars = [];
  for (const sample of samples) {
    if (sample.macd?.closedBars) closedBars = sample.macd.closedBars;
    now = sample.ts;
    bot.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => [
      side, structuredClone(sample.quotes?.[side] ?? {}),
    ]));
    bot.processPositionExits(now);
    const decision = sample.windowDecision;
    bot.applyPullbackSignal({
      method: METHOD, timeframe: '5m', status: 'READY',
      signalAt: decision?.previousCandle?.end,
      chart: { bars: closedBars.length ? closedBars
        : decision?.previousCandle ? [decision.previousCandle] : [] },
    });
    bot.processSignals(now);
  }
  bot.processPositionExits(start + 300_000);
  if (bot.trades.some(t => t.status === 'OPEN')) return null;
  return {
    pnl: bot.trades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0),
    trades: bot.entrySequence, finalCash: bot.cash,
  };
}

function choosePaperSettings(windows) {
  const compatible = [...windows].filter(w => w.samples?.some(s => s.pullback?.method === METHOD))
    .sort((a, b) => a.windowStart - b.windowStart).slice(-MIN_CLOSED_WINDOWS);
  const results = compatible.map(w => simulateWindow(w.samples)).filter(Boolean);
  return {
    applied: false, settings: { ...DEFAULT_SETTINGS }, windows: results.length,
    reason: 'Fixed window MACD policy: logging and regression only; automatic setting changes are disabled.',
    baseline: {
      pnl: results.reduce((sum, r) => sum + r.pnl, 0),
      trades: results.reduce((sum, r) => sum + r.trades, 0),
    },
  };
}

module.exports = { DEFAULT_SETTINGS, MIN_CLOSED_WINDOWS, choosePaperSettings, simulateWindow };
