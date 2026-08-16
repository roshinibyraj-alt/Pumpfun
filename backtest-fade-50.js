// ============================================================
// backtest-fade-50.js — SIMPLE fade-the-winner backtest on 15m
// Polymarket windows.
//
//   node backtest-fade-50.js [path-to-windows-json]
//
// Strategy: after a window starts, buy at 0.50 on the side OPPOSITE
// the previous window's winner (UP won -> buy DOWN, DOWN won -> buy
// UP). First window has no prior winner -> no trade.
//
// Variant A (limit): resting limit buy @ 0.50; fills when price
// walks through 0.50 (first tick <= 0.50), otherwise order expires.
// Variant B (instant): fills immediately at the first observed price.
// Payout: winner pays $1/share -> win +$0.50, loss -$0.50 (Variant A).
// ============================================================

const fs = require('fs');

const path = process.argv[2] || '/tmp/windows-15m-14d.json';
const windows = JSON.parse(fs.readFileSync(path, 'utf8'));

const WINDOW_SEC = 15 * 60;

function firstTickPrice(ticks) { return ticks.length ? ticks[0][1] : null; }
function firstTickAtOrBelow(ticks, level) {
  for (const [dt, p] of ticks) if (p <= level) return dt;
  return null;
}

function runVariant(windows, variant) {
  let trades = 0, wins = 0, totalPnl = 0;
  const bySide = { UP: { trades: 0, wins: 0, pnl: 0 }, DOWN: { trades: 0, wins: 0, pnl: 0 } };
  const byWeekday = {};
  const equity = [0];
  let peak = 0, maxDD = 0;

  for (let i = 1; i < windows.length; i++) {
    const cur = windows[i], prev = windows[i - 1];
    const side = prev.winner === 'UP' ? 'DOWN' : 'UP';
    const ticks = cur[side.toLowerCase()];

    let fillPrice = null;
    if (variant === 'limit') {
      if (firstTickAtOrBelow(ticks, 0.50) != null) fillPrice = 0.50;
    } else {
      fillPrice = firstTickPrice(ticks);
      if (fillPrice == null) continue;
    }
    if (fillPrice == null) continue; // order expired, no fill

    trades++;
    const won = cur.winner === side;
    const pnl = won ? (1 - fillPrice) : -fillPrice;
    if (won) wins++;
    totalPnl += pnl;

    const b = bySide[side];
    b.trades++; if (won) b.wins++; b.pnl += pnl;

    const d = new Date(cur.ws * 1000).getUTCDay();
    (byWeekday[d] ||= { trades: 0, wins: 0, pnl: 0 }).trades++;
    if (won) byWeekday[d].wins++;
    byWeekday[d].pnl += pnl;

    equity.push(equity[equity.length - 1] + pnl);
    if (equity[equity.length - 1] > peak) peak = equity[equity.length - 1];
    maxDD = Math.min(maxDD, equity[equity.length - 1] - peak);
  }
  return { trades, wins, totalPnl, bySide, byWeekday, equity, maxDD, winRate: trades ? wins / trades : 0 };
}

function fmt(name, r) {
  console.log(`\n=== ${name} ===`);
  console.log(`windows: ${windows.length}  trades: ${r.trades}  (skipped 1st window, no prior winner)`);
  console.log(`win rate: ${(r.winRate * 100).toFixed(2)}%  (${r.wins}/${r.trades})`);
  console.log(`P&L per share: $${r.totalPnl.toFixed(2)}   avg/trade: $${(r.trades ? r.totalPnl / r.trades : 0).toFixed(3)}`);
  console.log(`per \$10 bet (20 shares): $${(r.totalPnl * 20).toFixed(2)}   per \$50 bet (100 shares): $${(r.totalPnl * 100).toFixed(2)}`);
  console.log(`max drawdown (per share, peak-to-trough): $${r.maxDD.toFixed(2)}`);
  for (const side of ['UP', 'DOWN']) {
    const b = r.bySide[side];
    console.log(`  bought ${side}: ${b.trades} trades, ${(b.trades ? b.wins / b.trades * 100 : 0).toFixed(1)}% win, P&L $${b.pnl.toFixed(2)}`);
  }
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log('  by weekday (trades, win%, P&L/share):');
  for (let d = 0; d < 7; d++) {
    const b = r.byWeekday[d];
    if (!b) continue;
    console.log(`    ${days[d]}: ${b.trades}, ${(b.trades ? b.wins / b.trades * 100 : 0).toFixed(1)}%, $${b.pnl.toFixed(2)}`);
  }
}

const A = runVariant(windows, 'limit');
const B = runVariant(windows, 'instant');
fmt('Variant A — limit buy @ 0.50, fills on walk-through (expires if never hit)', A);
fmt('Variant B — instant buy at first observed price (reference)', B);
