'use strict';
const assert = require('node:assert/strict');
const { BotEngine, config } = require('../engine');

(async () => {
  const engine = new BotEngine({
    fetchImpl: async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/books') && options.method === 'POST') return { ok: true, json: async () => [] };
      if (u.includes('/markets')) {
        return { ok: true, json: async () => [{
          conditionId: '0xbtc', question: 'BTC test', closed: false,
          outcomes: '["Up","Down"]', clobTokenIds: '["up-id","down-id"]',
        }] };
      }
      throw new Error('unexpected url ' + u);
    },
  });

  // ── 1: Config ──
  assert.equal(engine.bankroll, 100, 'starts $100');
  assert.equal(config.BUY_PRICE, 0.01, 'buy $0.01');
  assert.equal(config.SHARES, 100, '100 shares');
  console.log('  ✓ config');

  // ── 2: Place exactly 2 buy orders (one per side) ──
  const cs = Math.floor((Date.now() - 60000) / 1000 / 300) * 300;
  const slug = `btc-updown-5m-${cs}`;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', title: 'test',
    windowStart: cs, windowEnd: cs + 300, resolved: false, winner: null, tradingClosed: false,
    up: { tokenId: 'up-id', slug, asset: 'btc', outcome: 'UP', bid: 0.50, ask: 0.55, mid: 0.525, updatedAt: Date.now(), bookAsks: [] },
    down: { tokenId: 'down-id', slug, asset: 'btc', outcome: 'DOWN', bid: 0.45, ask: 0.50, mid: 0.475, updatedAt: Date.now(), bookAsks: [] },
  });
  engine.placeBuyOrders(engine.markets.get(slug));
  const pending = engine.orders.filter(o => o.slug === slug && o.status === 'PENDING');
  assert.equal(pending.length, 2, 'exactly 2 pending buys');
  // No duplicate on second call
  engine.placeBuyOrders(engine.markets.get(slug));
  assert.equal(engine.orders.filter(o => o.slug === slug && o.status === 'PENDING').length, 2, 'no duplicate on second call');
  console.log('  ✓ exactly 2 orders, no duplicates');

  // ── 3: Buy fills when ask hits $0.01 ──
  const bankBefore = engine.bankroll;
  engine.markets.get(slug).up.ask = 0.01;
  engine.checkBuyFill(engine.markets.get(slug));
  const upFilled = engine.orders.find(o => o.slug === slug && o.outcome === 'UP' && o.status === 'FILLED');
  assert.ok(upFilled, 'UP buy filled');
  assert.equal(upFilled.fillPrice, 0.01, 'filled @ 0.01');
  assert.equal(upFilled.totalCost, round2(100 * 0.01), 'cost = $1.00');
  assert.equal(engine.bankroll, round2(bankBefore - 100 * 0.01), 'bankroll reduced');
  console.log('  ✓ buy fill at 0.01');

  // ── 4: No duplicate orders after fill ──
  engine.placeBuyOrders(engine.markets.get(slug));
  engine.placeBuyOrders(engine.markets.get(slug));
  assert.equal(engine.orders.filter(o => o.slug === slug && o.outcome === 'UP' && o.type === 'BUY').length, 1, 'still only 1 UP buy total');
  console.log('  ✓ no duplicate after fill');

  // ── 5: Cancel unfilled ──
  engine.cancelUnfilled(engine.markets.get(slug));
  const downCancelled = engine.orders.find(o => o.slug === slug && o.outcome === 'DOWN' && o.status === 'CANCELLED');
  assert.ok(downCancelled, 'DOWN buy cancelled');
  console.log('  ✓ unfilled cancelled');

  // ── 6: Resolution — both filled, Polymarket fallback ──
  const cs2 = cs + 300;
  const slug2 = `btc-updown-5m-${cs2}`;
  engine.markets.set(slug2, {
    slug: slug2, asset: 'btc', conditionId: '0xc1', title: 'test2',
    windowStart: cs2, windowEnd: cs2 + 300, resolved: false, winner: null, tradingClosed: false,
    up: { tokenId: 'up-id', slug: slug2, asset: 'btc', outcome: 'UP', bid: 0.00, ask: 0.01, mid: 0.005, updatedAt: Date.now(), bookAsks: [] },
    down: { tokenId: 'down-id', slug: slug2, asset: 'btc', outcome: 'DOWN', bid: 0.98, ask: 0.99, mid: 0.985, updatedAt: Date.now(), bookAsks: [] },
  });
  engine.lastOrderWindow = null;
  engine.placeBuyOrders(engine.markets.get(slug2));
  engine.markets.get(slug2).up.ask = 0.01; engine.markets.get(slug2).down.ask = 0.01;
  engine.checkBuyFill(engine.markets.get(slug2));
  assert.equal(engine.orders.filter(o => o.slug === slug2 && o.status === 'FILLED').length, 2, 'both filled');
  await engine.resolveWindow(engine.markets.get(slug2), engine.markets.get(slug2).windowEnd + 1);
  const resolved = engine.orders.filter(o => o.slug === slug2 && o.status === 'RESOLVED');
  assert.equal(resolved.length, 2, 'both resolved');
  const upRes = resolved.find(o => o.outcome === 'UP');
  const downRes = resolved.find(o => o.outcome === 'DOWN');
  // UP lost ($0 payout) → P&L = -$1.00
  assert.equal(upRes.pnl, -1.00, 'UP lost → -$1.00');
  // DOWN won ($100 payout) → P&L = +$99.00
  assert.equal(downRes.pnl, 99.00, 'DOWN won → +$99.00');
  console.log('  ✓ resolution: UP loss -$1, DOWN win +$99');

  // ── 7: Math check ──
  assert.equal(engine.wins, 1, '1 win');
  assert.equal(engine.losses, 1, '1 loss');
  const expectedPnl = round2(-1.00 + 99.00);
  assert.equal(engine.realizedPnl, expectedPnl, 'realized P&L correct');
  console.log(`  ✓ P&L: $${engine.realizedPnl.toFixed(2)}`);

  console.log('✅ All tests passed');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });

function round2(v) { return Math.round(v * 100) / 100; }
