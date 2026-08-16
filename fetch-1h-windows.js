// ============================================================
// fetch-1h-windows.js — fetch real 1-HOUR BTC Up/Down windows
// from Polymarket (per-hour events, slug
// bitcoin-up-or-down-{mon-day-year}-{h}{am|pm}-et), into the same
// format as windows-15m-14d.json:
//
//   node fetch-1h-windows.js [days=14] [out=/tmp/windows-1h-14d.json]
//
// Each hourly event contains one market whose endDate is the hour
// boundary; the window is the preceding 3600s. Winner comes from the
// resolved outcomePrices; ticks from the CLOB prices-history API.
// ============================================================

const fs = require('fs');
const polymarket = require('./polymarket');

const DAYS = parseInt(process.argv[2] || '14', 10);
const OUT = process.argv[3] || '/tmp/windows-1h-14d.json';
const FIDELITY = 1; // 1 point per second (hourly tokens need it; 60 caps to ~1 pt)
const CONCURRENCY = 8;

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

// ET is UTC-4 during the (summer) backtest period.
function slugForWindowStart(utcStart) {
  const et = new Date((utcStart - 4 * 3600) * 1000);
  const h = et.getUTCHours(); // 0-23 in ET
  const ampm = h === 0 ? '12am' : h < 12 ? h + 'am' : h === 12 ? '12pm' : (h - 12) + 'pm';
  return `bitcoin-up-or-down-${MONTHS[et.getUTCMonth()]}-${et.getUTCDate()}-${et.getUTCFullYear()}-${ampm}-et`;
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

async function fetchWindow(win) {
  try {
    const ev = await polymarket.getEventBySlug(win.slug);
    if (!ev || !ev.markets || !ev.markets.length) return { ...win, ok: false, reason: 'no event' };
    const mk = ev.markets[0];
    if (!mk || !mk.clobTokenIds) return { ...win, ok: false, reason: 'no market' };
    const endTs = Math.floor(new Date(mk.endDate).getTime() / 1000);
    if (Math.abs(endTs - win.windowEnd) > 300) return { ...win, ok: false, reason: `endDate mismatch ${endTs}` };
    const tokens = polymarket.parseTokens(mk);
    let trueWinner = null;
    try {
      const outs = JSON.parse(mk.outcomes || '[]');
      const prices = JSON.parse(mk.outcomePrices || '[]');
      const upIdx = outs.findIndex((o) => /up|yes/i.test(o));
      if (prices.length === 2 && upIdx >= 0 && prices[upIdx] != null) {
        const upP = parseFloat(prices[upIdx]);
        trueWinner = upP > 0.5 ? 'UP' : 'DOWN';
      }
    } catch (_) {}
    if (!trueWinner) return { ...win, ok: false, reason: 'unresolved' };
    const [upTicks, downTicks] = await Promise.all([
      polymarket.getPriceHistory(tokens.upTokenId, win.windowStart, win.windowEnd, FIDELITY),
      polymarket.getPriceHistory(tokens.downTokenId, win.windowStart, win.windowEnd, FIDELITY),
    ]);
    if (upTicks.length === 0 && downTicks.length === 0) return { ...win, ok: false, reason: 'no ticks' };
    return {
      ws: win.windowStart,
      winner: trueWinner,
      up: upTicks.map((x) => [x.t - win.windowStart, x.p]),
      down: downTicks.map((x) => [x.t - win.windowStart, x.p]),
      ok: true,
    };
  } catch (e) {
    return { ...win, ok: false, reason: e.message };
  }
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const hourSec = 3600;
  // last fully-elapsed hour boundary
  const lastBoundary = Math.floor(nowSec / hourSec) * hourSec;
  const windows = [];
  for (let i = 1; i <= DAYS * 24; i++) {
    const windowEnd = lastBoundary - i * hourSec;
    const windowStart = windowEnd - hourSec;
    windows.push({ slug: slugForWindowStart(windowStart), windowStart, windowEnd });
  }
  console.log(`fetching ${windows.length} hourly windows...`);
  const rows = [];
  let ok = 0, fail = 0;
  const reasons = {};
  for (let d = 0; d < DAYS; d++) {
    const dayChunk = windows.slice(d * 24, (d + 1) * 24);
    const res = await pool(dayChunk, fetchWindow, CONCURRENCY);
    for (const r of res) {
      if (r.ok) { ok++; rows.push({ ws: r.ws, winner: r.winner, up: r.up, down: r.down }); }
      else { fail++; reasons[r.reason] = (reasons[r.reason] || 0) + 1; }
    }
    fs.writeFileSync(OUT, JSON.stringify(rows));
    console.log(`day ${d + 1}/${DAYS}: ok=${ok} fail=${fail} (${JSON.stringify(reasons)})`);
  }
  rows.sort((a, b) => a.ws - b.ws);
  fs.writeFileSync(OUT, JSON.stringify(rows));
  console.log(`DONE: ${rows.length} windows -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
