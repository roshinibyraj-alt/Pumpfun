'use strict';

const { ProbabilityBot } = require('./probability-bot');
const { METHOD, CANDLE_MS } = require('./macd-signal');
const config = require('./config');

const VARIANTS = ['baseline', 'fourBar', 'trailing', 'combined'];
const TRAILING_GRID = [.05, .10, .15].flatMap(activation =>
  [.03, .05, .08].map(retracement => ({ activation, retracement })));
const fee = (price, shares) => config.CRYPTO_TAKER_FEE_RATE * price * (1 - price) * shares;

// Older samples rounded collection time down to 500ms. Use the bucket's upper
// bound, never a quote timestamp in the future. New logs preserve observedAt.
function sampleTime(sample) {
  return Number.isFinite(sample.observedAt) ? sample.observedAt : sample.ts + 499;
}

function validBar(bar) {
  return bar && Number.isFinite(bar.start) && bar.end === bar.start + CANDLE_MS
    && Number.isFinite(bar.histogram);
}

function historyIndex(windows) {
  const index = new Map();
  for (const window of windows) for (const sample of window.samples || []) {
    if (sample.pullback?.method !== METHOD || !Number.isFinite(sample.ts)) continue;
    const observedAt = sampleTime(sample);
    for (const bar of [sample.windowDecision?.previousCandle, ...(sample.macd?.closedBars || [])]) {
      if (!validBar(bar) || bar.end > observedAt) continue;
      const old = index.get(bar.end);
      if (!old || observedAt < old.observedAt) index.set(bar.end, { bar, observedAt });
    }
  }
  return index;
}

function strengtheningRun(start, observedAt, index) {
  const bars = [];
  for (let offset = 0; offset < 4; offset++) {
    const item = index.get(start - offset * CANDLE_MS);
    if (!item || item.observedAt > observedAt) return null;
    bars.push(item.bar);
  }
  // Each classification must be known as of this observation, not reconstructed
  // from a future candle. Equal or shrinking bars do not count as strengthening.
  const classes = bars.map(bar => bar.classification);
  if (classes.some(value => typeof value !== 'string')) return null;
  return classes.every(value => value === 'SOLID_GREEN') ? 'UP'
    : classes.every(value => value === 'SOLID_RED') ? 'DOWN' : false;
}

function sellDepth(bids, shares) {
  let remaining = shares, gross = 0, fees = 0;
  for (const level of [...(bids || [])].filter(level =>
    Number.isFinite(level.price) && level.price > 0 && level.price < 1
    && Number.isFinite(level.size) && level.size > 0).sort((a, b) => b.price - a.price)) {
    const quantity = Math.min(level.size, remaining);
    gross += quantity * level.price;
    fees += fee(level.price, quantity);
    remaining -= quantity;
    if (remaining <= 1e-8) return { gross, fees, price: gross / shares };
  }
  return null;
}

function eligibleSamples(window) {
  return (window.samples || []).filter(sample => sample.pullback?.method === METHOD
    && sample.windowStart === window.windowStart && Number.isFinite(sample.ts)
    && sampleTime(sample) >= window.windowStart
    && sampleTime(sample) < window.windowStart + CANDLE_MS)
    .sort((a, b) => sampleTime(a) - sampleTime(b));
}

function replay(window, variant, trailing, index) {
  const samples = eligibleSamples(window);
  let now = window.windowStart;
  const bot = new ProbabilityBot({ now: () => now, priceFeed: { start() {} } });
  bot.market = { id: 'comparison', start: now, end: now + CANDLE_MS, tokens: { UP: 'u', DOWN: 'd' } };
  bot.beginMarketWindow();
  let blocked = null, entryStopped = false, armed = false, highBid = null;
  let peakPnl = 0, trailingExits = 0, depthFailures = 0;
  const useFilter = variant === 'fourBar' || variant === 'combined';
  const useTrailing = variant === 'trailing' || variant === 'combined';
  for (const sample of samples) {
    now = sampleTime(sample);
    bot.quotes = structuredClone(sample.quotes || {});
    bot.processPositionExits(now);
    const previousCandle = sample.windowDecision?.previousCandle;
    bot.applyPullbackSignal({
      method: METHOD, timeframe: '5m', status: 'READY',
      signalAt: previousCandle?.end,
      chart: { bars: previousCandle ? [previousCandle] : [] },
    });
    if (bot.windowDecision.status === 'LOCKED' && blocked === null) {
      const run = strengtheningRun(window.windowStart, now, index);
      blocked = useFilter && run === bot.activeSide;
    }
    const open = bot.trades.filter(trade => trade.status === 'OPEN');
    const side = bot.activeSide;
    const quote = bot.quotes[side];
    const fresh = quote && Number.isFinite(quote.updatedAt) && now >= quote.updatedAt
      && now - quote.updatedAt <= 5000 && Number.isFinite(quote.bestBid);
    if (useTrailing && open.length && fresh) {
      const shares = open.reduce((sum, trade) => sum + trade.shares, 0);
      const cost = open.reduce((sum, trade) => sum + trade.totalCost, 0);
      const executable = sellDepth(quote.bids, shares);
      const profitPerShare = executable ? (executable.gross - executable.fees - cost) / shares : -Infinity;
      if (!armed && profitPerShare >= trailing.activation) {
        armed = true;
        highBid = quote.bestBid;
      }
      if (armed) highBid = Math.max(highBid, quote.bestBid);
      if (armed && quote.bestBid <= highBid - trailing.retracement + 1e-10) {
        entryStopped = true; // Never rebuild the position after a protective trigger.
        if (executable) {
          // Allocate the same aggregate execution price/fees across existing lots.
          for (const trade of open) bot.closeTrade(trade, executable.price,
            executable.price * trade.shares, 'TRAILING_EXIT',
            'Replay-only full-position visible-depth sweep.', now, executable.price,
            executable.fees * trade.shares / shares);
          trailingExits++;
          armed = false;
        } else depthFailures++;
      }
    }
    if (!blocked && !entryStopped) bot.processSignals(now);
    const realized = bot.trades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
    const mark = bot.trades.filter(trade => trade.status === 'OPEN').reduce((sum, trade) => {
      const q = bot.quotes[trade.side];
      if (!q || !Number.isFinite(q.bestBid) || !Number.isFinite(q.updatedAt)
        || q.updatedAt > now || now - q.updatedAt > 5000) return sum;
      return sum + trade.shares * q.bestBid - fee(q.bestBid, trade.shares) - trade.totalCost;
    }, 0);
    peakPnl = Math.max(peakPnl, realized + mark);
  }
  now = window.windowStart + CANDLE_MS;
  bot.processPositionExits(now);
  if (bot.trades.some(trade => trade.status === 'OPEN')) return null;
  const pnl = bot.trades.reduce((sum, trade) => sum + (trade.realizedPnl || 0), 0);
  return { windowStart: window.windowStart, pnl, trades: bot.entrySequence,
    peakPnl, giveback: Math.max(0, peakPnl - pnl), trailingExits, depthFailures,
    filtered: Boolean(blocked), stopAfterExit: entryStopped };
}

function summarize(rows) {
  let equity = 0, peak = 0, maxClosedWindowDrawdown = 0;
  for (const row of rows) {
    equity += row.pnl; peak = Math.max(peak, equity);
    maxClosedWindowDrawdown = Math.max(maxClosedWindowDrawdown, peak - equity);
  }
  return {
    windows: rows.length, pnl: equity,
    entries: rows.reduce((sum, row) => sum + row.trades, 0),
    winningWindows: rows.filter(row => row.pnl > 0).length,
    losingWindows: rows.filter(row => row.pnl < 0).length,
    noTradeWindows: rows.filter(row => row.trades === 0).length,
    filteredWindows: rows.filter(row => row.filtered).length,
    totalPeakGiveback: rows.reduce((sum, row) => sum + row.giveback, 0),
    maxClosedWindowDrawdown,
    trailingExits: rows.reduce((sum, row) => sum + row.trailingExits, 0),
    insufficientExitDepthSamples: rows.reduce((sum, row) => sum + row.depthFailures, 0),
  };
}

function compareStrategies(input, { minimumTrain = 20, minimumTest = 10 } = {}) {
  const windows = [...input].sort((a, b) => a.windowStart - b.windowStart);
  const index = historyIndex(windows);
  const excluded = { incompatible: 0, missingHistory: 0, incompleteQuotes: 0, unresolved: 0, duplicate: 0 };
  const cohort = [], seen = new Set();
  for (const window of windows) {
    if (seen.has(window.windowStart)) { excluded.duplicate++; continue; }
    seen.add(window.windowStart);
    const samples = eligibleSamples(window);
    const decided = samples.find(sample => sample.windowDecision?.previousCandle?.end === window.windowStart);
    if (!decided || samples.length < 20) { excluded.incompatible++; continue; }
    if (strengtheningRun(window.windowStart, sampleTime(decided), index) === null) {
      excluded.missingHistory++; continue;
    }
    // Paired variants share the same quote coverage. Missing scheduled slots are
    // not filled by invented/interpolated quotes; require a near-close observation.
    if (sampleTime(samples.at(-1)) < window.windowStart + 295000) {
      excluded.incompleteQuotes++; continue;
    }
    if (!replay(window, 'baseline', null, index)) { excluded.unresolved++; continue; }
    cohort.push(window);
  }
  const split = Math.floor(cohort.length * .7);
  const train = cohort.slice(0, split), test = cohort.slice(split);
  const report = {
    version: 'macd-protection-comparison-v1', applied: false, tradingChanged: false,
    status: train.length >= minimumTrain && test.length >= minimumTest ? 'ready' : 'insufficient-data',
    method: METHOD, inputWindows: windows.length, usableWindows: cohort.length, excluded,
    split: { trainingWindows: train.length, holdoutWindows: test.length,
      firstWindow: cohort[0]?.windowStart ?? null, holdoutStart: test[0]?.windowStart ?? null,
      lastWindow: cohort.at(-1)?.windowStart ?? null },
    assumptions: [
      'Observational replay only; no trading settings are changed.',
      'Chronological 70/30 split. Trailing parameters are selected on training windows only.',
      'Four consecutive SOLID_GREEN or SOLID_RED closed 5m bars block that same direction; no automatic reversal.',
      'Trailing protects the aggregate open position; activation uses net visible-depth liquidation profit per share.',
      'Trailing triggers stop all later scheduled buys in that window; insufficient full exit depth defers the exit.',
      'Each window starts with the same $10,000 paper cash. Summed P&L is not a continuous funded account simulation.',
      'Original 50-share schedule, entry liquidity, fees and threshold/expiry conventions are retained.',
      'Original TP/SL and expiry are paper marks, not proof of executable live fills.',
      'Legacy log times use the upper bound of their 500ms collection bucket; slot timing remains approximate.',
      'Peak giveback uses bid marks; drawdown is measured between closed windows, not full intrawindow drawdown.',
      'No historical order-queue or latency model. Holdout evidence is not a profit guarantee.',
      'Stored books are projected to at most 20 recorded levels per side; insufficient retained depth skips/defer fills rather than inventing liquidity.',
    ],
    trailingCandidates: TRAILING_GRID, variants: {},
  };
  if (report.status !== 'ready') return report;
  for (const variant of VARIANTS) {
    const configurations = variant === 'trailing' || variant === 'combined' ? TRAILING_GRID : [null];
    const ranked = configurations.map(parameters => {
      const rows = train.map(window => replay(window, variant, parameters, index));
      return { parameters, rows, score: rows.every(Boolean) ? summarize(rows).pnl : -Infinity };
    }).sort((a, b) => b.score - a.score);
    const selected = ranked[0];
    const holdoutRows = test.map(window => replay(window, variant, selected.parameters, index));
    if (!Number.isFinite(selected.score) || holdoutRows.some(row => !row)) {
      report.status = 'incomplete-comparison';
      report.variants[variant] = { status: 'unresolved-window' };
      continue;
    }
    report.variants[variant] = { parameters: selected.parameters,
      training: summarize(selected.rows), holdout: summarize(holdoutRows), holdoutWindows: holdoutRows };
  }
  report.recommendation = 'Do not auto-apply. Review holdout P&L, giveback, drawdown, coverage and trade reduction before changing the bot.';
  return report;
}

module.exports = { compareStrategies, replay, historyIndex, strengtheningRun, sellDepth, sampleTime };
