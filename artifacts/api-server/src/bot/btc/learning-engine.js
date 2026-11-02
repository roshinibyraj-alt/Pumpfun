'use strict';

const { probabilityUp, simulateBuy } = require('./probability-bot');

const DEFAULT_SETTINGS = Object.freeze({
  openingDelaySeconds: 30,
  minimumNetEdge: 0.05,
  lowPriceThreshold: 0.25,
  lowPriceMinimumNetEdge: 0.10,
  volatilityMultiplier: 1,
  sharesPerSignal: 100,
  sideMode: 'best-edge',
});

const MIN_CLOSED_WINDOWS = 100;
const MAX_CLOSED_WINDOWS = 400;
const TAKER_FEE_RATE = 0.07;
const CANDIDATES = Object.freeze([
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 45, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 60, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.07, lowPriceMinimumNetEdge: 0.12, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 0.9, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1.1, sharesPerSignal: 100, sideMode: 'best-edge' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 50, sideMode: 'best-edge' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'UP-only' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'DOWN-only' },
  { openingDelaySeconds: 30, minimumNetEdge: 0.05, lowPriceMinimumNetEdge: 0.10, volatilityMultiplier: 1, sharesPerSignal: 100, sideMode: 'pullback' },
]);

function simulateWindow(windowSamples, settings) {
  const samples = [...windowSamples].sort((a, b) => a.ts - b.ts);
  if (samples.length < 20) return null;
  let cash = 10_000;
  let realized = 0;
  let tradeCount = 0;
  let open = [];
  const armed = { UP: true, DOWN: true };
  const ending = samples[samples.length - 1];

  for (const sample of samples) {
    for (const trade of open) {
      const bid = sample.quotes?.[trade.side]?.bestBid;
      if (!Number.isFinite(bid)) continue;
      if (bid >= 0.99 || bid <= 0.01) {
        const payout = bid >= 0.99 ? trade.shares : 0;
        const fee = TAKER_FEE_RATE * bid * (1 - bid) * trade.shares;
        const pnl = payout - fee - trade.totalCost;
        cash += payout - fee;
        realized += pnl;
        trade.closed = true;
      }
    }
    open = open.filter(trade => !trade.closed);

    if (!Number.isFinite(sample.secondsSinceOpen)
      || sample.secondsSinceOpen < settings.openingDelaySeconds
      || !Number.isFinite(sample.referencePrice)
      || !Number.isFinite(sample.spotPrice)
      || !Number.isFinite(sample.volatility5m)
      || !Number.isFinite(sample.secondsRemaining)
      || sample.secondsRemaining <= 0) continue;

    const pUp = probabilityUp({
      openPrice: sample.referencePrice,
      spotPrice: sample.spotPrice,
      secondsRemaining: sample.secondsRemaining,
      volatility5m: sample.volatility5m * settings.volatilityMultiplier,
    });
    if (!Number.isFinite(pUp)) continue;
    if (['UP', 'DOWN'].some(side => {
      const ask = sample.quotes?.[side]?.bestAsk;
      return Number.isFinite(ask) && ask < 0.02;
    })) continue;

    const candidates = ['UP', 'DOWN'].filter(side => settings.sideMode === 'best-edge'
      || settings.sideMode === `${side}-only`
      || (settings.sideMode === 'pullback' && sample.pullback?.side === side)).map(side => {
      const fill = simulateBuy(sample.quotes?.[side]?.asks, settings.sharesPerSignal);
      if (!fill) return null;
      const probability = side === 'UP' ? pUp : 1 - pUp;
      const edge = probability - fill.totalCost / settings.sharesPerSignal;
      const threshold = fill.averagePrice < settings.lowPriceThreshold
        ? settings.lowPriceMinimumNetEdge : settings.minimumNetEdge;
      return { side, fill, edge, threshold };
    }).filter(candidate => candidate && candidate.edge >= candidate.threshold && armed[candidate.side])
      .sort((a, b) => b.edge - a.edge);

    for (const side of ['UP', 'DOWN']) {
      const bestAsk = sample.quotes?.[side]?.bestAsk;
      if (Number.isFinite(bestAsk) && bestAsk < 0.02) continue;
      const sideProbability = side === 'UP' ? pUp : 1 - pUp;
      const sideFill = simulateBuy(sample.quotes?.[side]?.asks, settings.sharesPerSignal);
      if (!sideFill) continue;
      const threshold = sideFill.averagePrice < settings.lowPriceThreshold
        ? settings.lowPriceMinimumNetEdge : settings.minimumNetEdge;
      if (sideProbability - sideFill.totalCost / settings.sharesPerSignal < threshold) armed[side] = true;
    }

    const selected = candidates[0];
    if (!selected) continue;
    armed[selected.side] = false;
    if (cash < selected.fill.totalCost) continue;
    cash -= selected.fill.totalCost;
    tradeCount += 1;
    open.push({
      side: selected.side,
      shares: settings.sharesPerSignal,
      totalCost: selected.fill.totalCost,
      closed: false,
    });
  }

  for (const trade of open) {
    const bid = ending.quotes?.[trade.side]?.bestBid;
    if (!Number.isFinite(bid)) return null;
    const payout = bid * trade.shares;
    const fee = TAKER_FEE_RATE * bid * (1 - bid) * trade.shares;
    const pnl = payout - fee - trade.totalCost;
    cash += payout - fee;
    realized += pnl;
  }
  return { pnl: realized, trades: tradeCount, finalCash: cash };
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
    .filter(window => Array.isArray(window.samples) && window.samples.length >= 20)
    .sort((a, b) => a.windowStart - b.windowStart)
    .slice(-MAX_CLOSED_WINDOWS);
  if (chronological.length < MIN_CLOSED_WINDOWS) {
    return { applied: false, reason: 'INSUFFICIENT_HISTORY', windows: chronological.length, settings: currentSettings };
  }

  const split = Math.floor(chronological.length * 0.7);
  const training = chronological.slice(0, split);
  const holdout = chronological.slice(split);
  const baseline = scoreWindows(holdout, currentSettings);
  if (!baseline || holdout.length < 20) {
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
