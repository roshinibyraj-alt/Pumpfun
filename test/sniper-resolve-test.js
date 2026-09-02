'use strict';
// Regression test: SniperBot positions held through window end must be RESOLVED
// from the previous window's final-2s max prices (via deferred settlement).
const assert = require('node:assert/strict');
const { SniperEngine } = require('../sniperEngine');
function round2(v){return Math.round(v*100)/100}

(async () => {
  let fakeNow = 1250 * 1000; // mid-window 1000 (1000–1300)
  const RealDate = Date;
  const RealNow = Date.now;
  Date.now = () => fakeNow;
  global.Date = Date;

  const markets = new Map();
  const tokens = new Map();
  const sniper = new SniperEngine({ markets, tokens });

  const mkMarket = (start) => {
    const slug = `btc-updown-5m-${start}`;
    const m = {
      slug, asset: 'btc', conditionId: '0x' + start, title: 't' + start,
      windowStart: start, windowEnd: start + 300, resolved: false, winner: null, tradingClosed: false,
      finalUpMax: null, finalDownMax: null,
      up:   { tokenId: 'up' + start, slug, asset: 'btc', outcome: 'UP',   bid: 0.5, ask: 0.6, mid: 0.55, updatedAt: fakeNow, bookAsks: [] },
      down: { tokenId: 'dn' + start, slug, asset: 'btc', outcome: 'DOWN', bid: 0.4, ask: 0.5, mid: 0.45, updatedAt: fakeNow, bookAsks: [] },
    };
    markets.set(slug, m);
    tokens.set(m.up.tokenId, m.up);
    tokens.set(m.down.tokenId, m.down);
    return m;
  };

  // ── Case A: held DOWN, finalDownMax=0.99 → WIN (deferred settlement) ──
  console.log('── Case A: held DOWN, deferred set. finalDownMax=0.99 → WIN ──');
  const m1 = mkMarket(1000);
  sniper.lastWindow = 1000;
  sniper.entryWindow = 1000;
  sniper.windowPosition = { side: 'DOWN', shares: 28, fillPrice: 0.89, cost: round2(28 * 0.89), windowStart: 1000 };
  sniper.currentBet = 25.13;
  m1.finalDownMax = 0.99;
  m1.finalUpMax = 0.50;

  // Transition to next window (1300–1600) — no winner visible yet
  mkMarket(1300);
  fakeNow = 1305 * 1000;
  // Clear final maxes to simulate race — sniper sees no winner on first tick
  m1.finalUpMax = null;
  m1.finalDownMax = null;
  sniper.evaluate();
  // First tick: deferred, no winner yet
  assert.ok(sniper.pendingSettle, 'pendingSettle set after transition');
  assert.equal(sniper.windowPosition, null, 'position cleared from windowPosition');
  console.log('  ✓ Deferred settle: pendingSettle is set, position cleared');

  // Set final maxes (simulating CLOB poll arriving ~100ms later)
  m1.finalDownMax = 0.99;
  sniper.evaluate();
  // Second tick: resolves WIN
  assert.equal(sniper.pendingSettle, null, 'pendingSettle cleared after resolution');
  const winTrade = sniper.trades.find(t => t.type === 'RESOLVED');
  assert.ok(winTrade, 'has RESOLVED trade');
  assert.equal(winTrade.winner, 'DOWN', 'DOWN resolved winner');
  assert.ok(winTrade.pnl > 0, 'winning P&L');
  assert.equal(sniper.consecutiveLosses, 0, 'wins reset martingale');
  assert.equal(sniper.currentBet, round2(0.067 * 150), 'bet reset to base');
  console.log(`  ✓ WIN resolved: +$${winTrade.pnl.toFixed(2)} · capital $${sniper.capital.toFixed(2)}`);

  // ── Case B: held UP, neither side reaches 0.95 → REFUND after grace ──
  console.log('── Case B: deferred settle, no winner → REFUND after grace ──');
  const m2 = mkMarket(1500);
  sniper.lastWindow = 1500;
  sniper.entryWindow = 1300;
  const capB0 = sniper.capital;
  sniper.windowPosition = { side: 'UP', shares: 11, fillPrice: 0.89, cost: round2(11 * 0.89), windowStart: 1500 };
  m2.finalUpMax = 0.80;
  m2.finalDownMax = 0.70;

  mkMarket(1800);
  // Clear final maxes to simulate CLOB race (maxes not yet captured)
  m2.finalUpMax = null;
  m2.finalDownMax = null;
  fakeNow = 1805 * 1000;
  sniper.evaluate();
  assert.ok(sniper.pendingSettle, 'pendingSettle set');

  // Simulate CLOB poll arrives but still no winner (both <0.95)
  m2.finalUpMax = 0.80;
  m2.finalDownMax = 0.70;
  console.log('DEBUG before eval: pendingSettle ts=' + sniper.pendingSettle.ts + ' now=' + Date.now() + ' diff=' + (Date.now()-sniper.pendingSettle.ts) + ' grace=2500');
  sniper.evaluate();
  console.log('DEBUG after eval: pendingSettle=' + sniper.pendingSettle);
  // Still pending — trySettle returns false (no winner), grace not elapsed
  assert.ok(sniper.pendingSettle, 'still pending after non-winning poll');

  // Simulate grace period elapsed (2500ms+)
  fakeNow = 1808 * 1000;
  sniper.evaluate();
  // After grace period: refund
  assert.equal(sniper.pendingSettle, null, 'pendingSettle cleared after grace refund');
  assert.equal(sniper.capital, round2(capB0 + round2(11 * 0.89)), 'cost refunded');
  console.log(`  ✓ REFUND confirmed: capital $${sniper.capital.toFixed(2)} (no RESOLVED trade)`);

  // ── Case C: held DOWN, finalUpMax=0.99 → LOSS (deferred settlement) ──
  console.log('── Case C: deferred set. finalUpMax=0.99 → LOSS ──');
  const m3 = mkMarket(2000);
  sniper.lastWindow = 2000;
  sniper.entryWindow = 1800;
  const capC0 = sniper.capital;
  const costC = round2(44 * 0.89);
  sniper.windowPosition = { side: 'DOWN', shares: 44, fillPrice: 0.89, cost: costC, windowStart: 2000 };
  m3.finalUpMax = null;
  m3.finalDownMax = null;

  mkMarket(2300);
  fakeNow = 2305 * 1000;
  sniper.evaluate();
  assert.ok(sniper.pendingSettle, 'pendingSettle set');

  // Simulate CLOB poll arrives with UP max = 0.99
  m3.finalUpMax = 0.99;
  sniper.evaluate();
  assert.equal(sniper.pendingSettle, null, 'pendingSettle cleared');
  const lossTrade = sniper.trades.filter(t => t.type === 'RESOLVED').at(-1);
  assert.ok(lossTrade && lossTrade.pnl < 0, 'LOSS recorded');
  assert.equal(lossTrade.winner, 'UP', 'UP winner');
  assert.ok(sniper.consecutiveLosses === 1, 'loss escalates martingale');
  assert.ok(sniper.currentBet > round2(0.067 * 150), 'bet escalated');
  console.log(`  ✓ LOSS resolved: -$${Math.abs(lossTrade.pnl).toFixed(2)} · capital $${sniper.capital.toFixed(2)} · next bet $${sniper.currentBet.toFixed(2)}`);

  global.Date = RealDate;
  Date.now = RealNow;
  console.log('\n✅ sniper-resolve-test passed');
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message, e.stack); global.Date = RealDate; Date.now = RealNow; process.exit(1); });
