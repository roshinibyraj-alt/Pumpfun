'use strict';

const { ProbabilityBot, DEFAULT_STRATEGY_SETTINGS } = require('./probability-bot');
const { METHOD } = require('./technical-signal');

const DEFAULT_SETTINGS = DEFAULT_STRATEGY_SETTINGS;
const MIN_CLOSED_WINDOWS = 15;

// Replay only samples captured with the current closed-candle hybrid signal.
function simulateWindow(windowSamples) {
  const samples = [...windowSamples].filter(s => s.technicalSignal?.method === METHOD)
    .sort((a, b) => a.ts - b.ts);
  if (samples.length < 20) return null;
  let now = samples[0].ts;
  const start = samples[0].windowStart;
  if (!Number.isFinite(start) || samples.some(s => s.windowStart !== start)) return null;
  const bot = new ProbabilityBot({ now: () => now, priceFeed: { start() {} } });
  bot.market = { id: 'replay', start, end: start + 300_000, tokens: { UP: 'u', DOWN: 'd' } };
  const initialSide = samples[0].technicalSignal?.side ?? null;
  bot.activeSide = ['UP', 'DOWN'].includes(initialSide) ? initialSide : null;
  bot.beginMarketWindow();
  for (const sample of samples) {
    now = sample.ts;
    bot.quotes = Object.fromEntries(['UP', 'DOWN'].map(side => [
      side, structuredClone(sample.quotes?.[side] ?? {}),
    ]));
    bot.processPositionExits(now);
    if (sample.technicalSignal) bot.applyTechnicalSignal(sample.technicalSignal);
    else bot.marketSignal = { status: 'WAITING_HISTORY' };
    bot.processSignals(now);
  }
  bot.processPositionExits(start + 300_000, { allowWindowPriceExit: true });
  if (bot.trades.some(t => t.status === 'OPEN')) return null;
  return {
    pnl: bot.trades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0),
    trades: bot.entrySequence, finalCash: bot.cash,
  };
}

function choosePaperSettings(windows) {
  const compatible = [...windows].filter(w => w.samples?.some(s => s.technicalSignal?.method === METHOD))
    .sort((a, b) => a.windowStart - b.windowStart).slice(-MIN_CLOSED_WINDOWS);
  const results = compatible.map(w => simulateWindow(w.samples)).filter(Boolean);
  return {
    applied: false, settings: { ...DEFAULT_SETTINGS }, windows: results.length,
    reason: 'Fixed hybrid trend/range signal with directional fallback: regression only; automatic setting changes are disabled.',
    baseline: {
      pnl: results.reduce((sum, r) => sum + r.pnl, 0),
      trades: results.reduce((sum, r) => sum + r.trades, 0),
    },
  };
}

module.exports = { DEFAULT_SETTINGS, MIN_CLOSED_WINDOWS, choosePaperSettings, simulateWindow };
