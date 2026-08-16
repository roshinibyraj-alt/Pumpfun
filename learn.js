// ============================================================
// learn.js — backtests the LEADER strategy (plus the historical
// ladder variants it replaced) against REAL Polymarket price history,
// then writes learn.json for the dashboard "Learn" panel.
//
//   npm run learn        — refresh now and print a summary
//   (server)             — auto-refreshes on boot if LEARN_ON_BOOT
//
// Variants evaluated (see config.LEARN): base, timeFilter, cap, tp,
// all (ladder history) and leader (the live strategy).
// ============================================================

const fs = require('fs');
const config = require('./config');
const polymarket = require('./polymarket');
const { replayWindow } = require('./ladder-replay');

const LEARN_FILE = config.LEARN.LEARN_FILE || './learn.json';

function round2(n) { return Math.round(n * 100) / 100; }
function round5(n) { return Math.round(n * 100000) / 100000; }

function log(...args) { console.log(new Date().toISOString(), '-', ...args); }

// Past window slugs per engine: `{asset}-updown-{windowMinutes}m-{ts}`.
// tfLabel is the engine key ('5m' / '15m'); windowMinutes is numeric.
function windowSlugs(asset, tfLabel, windowMinutes, count) {
  const nowSec = Math.floor(Date.now() / 1000);
  const sec = windowMinutes * 60;
  const lastBoundary = Math.floor(nowSec / sec) * sec;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const ts = lastBoundary - i * sec;
    out.push({ slug: `${asset}-updown-${windowMinutes}m-${ts}`, windowStart: ts, windowEnd: ts + sec, tf: tfLabel });
  }
  return out;
}

async function pool(items, worker, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, next));
  return results;
}

async function fetchWindowData(win) {
  try {
    const event = await polymarket.getEventBySlug(win.slug);
    if (!event) return { ...win, ok: false, reason: 'no event' };
    const mk = (event.markets || [])[0];
    if (!mk || !mk.clobTokenIds) return { ...win, ok: false, reason: 'no market' };
    const tokens = polymarket.parseTokens(mk);
    // Authoritative winner from the closed market's outcomePrices.
    let trueWinner = null;
    try {
      const outs = JSON.parse(mk.outcomes || '[]');
      const prices = JSON.parse(mk.outcomePrices || '[]');
      const upIdx = outs.findIndex((o) => /up|yes/i.test(o));
      if (prices.length === 2 && upIdx >= 0) {
        trueWinner = parseFloat(prices[upIdx]) > 0.5 ? 'UP' : 'DOWN';
      }
    } catch (_) {}
    const [upTicks, downTicks] = await Promise.all([
      polymarket.getPriceHistory(tokens.upTokenId, win.windowStart, win.windowEnd, config.LEARN.FIDELITY),
      polymarket.getPriceHistory(tokens.downTokenId, win.windowStart, win.windowEnd, config.LEARN.FIDELITY),
    ]);
    if (upTicks.length === 0 && downTicks.length === 0) return { ...win, ok: false, reason: 'no ticks' };
    return { ...win, ok: true, trueWinner, upTicks, downTicks };
  } catch (e) {
    return { ...win, ok: false, reason: e.message };
  }
}

function variantOpts() {
  const L = config.LEARN;
  const common = {
    rungs: config.LADDER_RUNGS,
    shares: config.RUNG_SHARES,
    baseTakerFeeRate: config.BASE_TAKER_FEE_RATE,
    makerRebateRate: config.MAKER_REBATE_RATE,
  };
  return {
    base: { ...common },
    timeFilter: { ...common, deepRungs: L.DEEP_RUNGS, timeFilterFraction: L.TIME_FILTER_FRACTION },
    cap: { ...common, capRungs: L.CAP_RUNGS, capTailShares: L.CAP_TAIL_SHARES },
    tp: { ...common, takeProfit: L.TAKE_PROFIT },
    all: {
      ...common,
      deepRungs: L.DEEP_RUNGS,
      timeFilterFraction: L.TIME_FILTER_FRACTION,
      capRungs: L.CAP_RUNGS,
      capTailShares: L.CAP_TAIL_SHARES,
      takeProfit: L.TAKE_PROFIT,
    },
    // Live strategy (v31): TAKER execution — immediate fill at the
    // leader mid ± slippage, taker fee charged. leaderMaker keeps the
    // v30 resting-limit walk-through model for comparison.
    leader: {
      ...common,
      buyLeader: true,
      stopLossPrice: config.LEADER.STOP_LOSS_PRICE,
      entryCutoffSec: config.LEADER.ENTRY_CUTOFF_SEC,
      taker: config.ENTRY_MODE === 'taker',
      slippageMin: config.TAKER_SLIPPAGE_MIN,
      slippageMax: config.TAKER_SLIPPAGE_MAX,
      seed: 12345,
    },
    leaderMaker: { ...common, buyLeader: true, walkThrough: true, stopLossPrice: config.LEADER.STOP_LOSS_PRICE, entryCutoffSec: config.LEADER.ENTRY_CUTOFF_SEC },
  };
}

function aggregate(rows, name) {
  let pnl = 0, traded = 0, wins = 0, fullWins = 0, mixed = 0, cost = 0, sells = 0, fees = 0;
  for (const w of rows) {
    const v = w.results && w.results[name];
    if (!v) continue;
    if (v.fills.length > 0) traded += 1;
    pnl += v.pnl;
    cost += v.cost;
    fees += v.fees || 0;
    sells += (v.sellEvents || []).length;
    if (v.pnl >= 0) wins += 1;
    if (v.fullRoundWon) fullWins += 1;
    if (v.mixed) mixed += 1;
  }
  return {
    windows: rows.length,
    traded,
    wins,
    fullWins,
    mixed,
    sells,
    cost: round2(cost),
    pnl: round2(pnl),
    fees: round2(fees),
  };
}

// Per-rung stats from the BASE replay: how often each level is
// touched (mid <= level), how often it fills, and how often the
// filled side actually WON the window (vs the level's implied
// probability = the level itself).
function rungStats(rows, rungs) {
  return rungs.slice().sort((a, b) => b - a).map((price) => {
    let touches = 0, fills = 0, winFills = 0, pnl = 0;
    for (const w of rows) {
      const v = w.results && w.results.base;
      if (!v) continue;
      const touched = (w.upTicks || []).some((x) => x.p <= price) || (w.downTicks || []).some((x) => x.p <= price);
      if (touched) touches += 1;
      const levelFills = v.fills.filter((f) => f.price === price);
      fills += levelFills.length;
      for (const f of levelFills) {
        pnl += f.shares * (f.side === v.winner ? 1 : 0) - f.shares * f.price;
        if (f.side === v.winner) winFills += 1;
      }
    }
    const winRate = fills > 0 ? round5(winFills / fills) : null;
    return {
      level: price,
      touches,
      fills,
      winRate,
      edge: winRate != null ? round5(winRate - price) : null, // fill-side: actual win rate minus implied
      // LEADER side (buy the opposite when the dipper crosses this
      // level): its implied price is ~1 - level.
      leaderWinRate: winRate != null ? round5(1 - winRate) : null,
      leaderImplied: 1 - price,
      leaderEdge: winRate != null ? round5((1 - winRate) - (1 - price)) : null,
      avgPnl: fills > 0 ? round2(pnl / fills) : null,
    };
  });
}

async function runLearn() {
  const L = config.LEARN;
  const all = [];
  for (const [tf, n] of Object.entries(L.WINDOWS || {})) {
    all.push(...windowSlugs(config.ASSET, tf, parseInt(tf), n));
  }
  log(`Learn: fetching ${all.length} windows (${Object.entries(L.WINDOWS).map(([k, v]) => `${k} x${v}`).join(', ')})`);

  const fetched = await pool(all, fetchWindowData, 8);
  const ok = fetched.filter((w) => w.ok);
  log(`Learn: ${ok.length}/${fetched.length} windows fetched (${fetched.length - ok.length} skipped: ${Array.from(new Set(fetched.filter((w) => !w.ok).map((w) => w.reason))).join('; ')})`);

  const variants = variantOpts();
  const perTf = {};
  for (const tf of Object.keys(L.WINDOWS)) {
    const rows = ok.filter((w) => w.tf === tf);
    for (const w of rows) {
      w.results = {};
      for (const [name, opts] of Object.entries(variants)) {
        w.results[name] = replayWindow({ windowStart: w.windowStart, windowEnd: w.windowEnd, upTicks: w.upTicks, downTicks: w.downTicks, winnerOverride: w.trueWinner, ...opts });
      }
    }
    const agg = {};
    for (const name of Object.keys(variants)) agg[name] = aggregate(rows, name);
    perTf[tf] = {
      windows: rows.length,
      variants: agg,
      rungs: rungStats(rows, config.LADDER_RUNGS),
    };
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    config: {
      WINDOWS: L.WINDOWS,
      FIDELITY: L.FIDELITY,
      DEEP_RUNGS: L.DEEP_RUNGS,
      TIME_FILTER_FRACTION: L.TIME_FILTER_FRACTION,
      CAP_RUNGS: L.CAP_RUNGS,
      CAP_TAIL_SHARES: L.CAP_TAIL_SHARES,
      TAKE_PROFIT: L.TAKE_PROFIT,
    },
    engines: perTf,
  };
  fs.writeFileSync(LEARN_FILE, JSON.stringify(out, null, 2));
  log(`Learn: wrote ${LEARN_FILE}`);
  return out;
}

function printSummary(summary) {
  const L = config.LEARN;
  for (const [tf, e] of Object.entries(summary.engines)) {
    console.log(`\n=== ${tf} engine — ${e.windows} windows ===`);
    console.log('Variant       P&L      Traded  Wins  FullW  Mixed  Sells');
    for (const [name, v] of Object.entries(e.variants)) {
      console.log(
        String(name).padEnd(13),
        (v.pnl >= 0 ? '+' : '') + v.pnl.toFixed(2).padStart(8),
        String(v.traded).padStart(7),
        String(v.wins).padStart(5),
        String(v.fullWins).padStart(5),
        String(v.mixed).padStart(6),
        String(v.sells).padStart(6)
      );
    }
    console.log('Rung   Touches Fills  WinRate  Edge   AvgPnl/fill');
    for (const r of e.rungs) {
      console.log(
        r.level.toFixed(2).padEnd(6),
        String(r.touches).padEnd(8),
        String(r.fills).padEnd(6),
        (r.winRate != null ? (r.winRate * 100).toFixed(1) + '%' : '—').padEnd(8),
        (r.edge != null ? ((r.edge >= 0 ? '+' : '') + (r.edge * 100).toFixed(1) + '%') : '—').padEnd(8),
        (r.avgPnl != null ? r.avgPnl.toFixed(2) : '—')
      );
    }
  }
}

if (require.main === module) {
  runLearn()
    .then((s) => { printSummary(s); process.exit(0); })
    .catch((e) => { console.error('Learn failed:', e); process.exit(1); });
}

module.exports = { runLearn, printSummary };
