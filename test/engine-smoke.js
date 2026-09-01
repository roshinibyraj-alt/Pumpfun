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
  assert.equal(engine.bankroll, 500, 'starts $500');
  assert.deepEqual(config.BUY_PRICES, [0.10, 0.05], 'buy prices 0.10 + 0.05');
  assert.equal(config.SHARES, 100, '100 shares');
  assert.equal(config.ORDER_WINDOW_SECONDS, 150, '150s cancel');
  console.log('  ✓ config');

  // ── 2: Place 4 buy orders (2 per side × 2 levels) ──
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
  assert.equal(pending.length, 4, '4 pending orders');
  // Verify price levels
  const up10 = pending.find(o => o.outcome === 'UP' && o.price === 0.10);
  const up5 = pending.find(o => o.outcome === 'UP' && o.price === 0.05);
  const dn10 = pending.find(o => o.outcome === 'DOWN' && o.price === 0.10);
  const dn5 = pending.find(o => o.outcome === 'DOWN' && o.price === 0.05);
  assert.ok(up10, 'UP @ 0.10'); assert.ok(up5, 'UP @ 0.05');
  assert.ok(dn10, 'DOWN @ 0.10'); assert.ok(dn5, 'DOWN @ 0.05');
  assert.equal(up10.shares, 100); assert.equal(up5.shares, 100);
  console.log('  ✓ 4 orders placed: UP+DOWN @ 0.10 & 0.05');

  // ── 3: No duplicates ──
  engine.placeBuyOrders(engine.markets.get(slug));
  assert.equal(engine.orders.filter(o => o.slug === slug && o.status === 'PENDING').length, 4, 'no duplicates');
  console.log('  ✓ no duplicates');

  // ── 4: Fill at each price level ──
  engine.markets.get(slug).up.ask = 0.10;
  engine.checkBuyFill(engine.markets.get(slug));
  const up10Filled = engine.orders.find(o => o.slug === slug && o.outcome === 'UP' && o.price === 0.10 && o.status === 'FILLED');
  assert.ok(up10Filled, 'UP @ 0.10 filled');
  assert.equal(up10Filled.totalCost, round2(100 * 0.10 - 100 * 0.10 * 0.001), 'cost ≈$10 minus rebate');
  console.log('  ✓ UP @ 0.10 fills, cost $10');

  engine.markets.get(slug).down.ask = 0.05;
  engine.checkBuyFill(engine.markets.get(slug));
  const dn5Filled = engine.orders.find(o => o.slug === slug && o.outcome === 'DOWN' && o.price === 0.05 && o.status === 'FILLED');
  assert.ok(dn5Filled, 'DOWN @ 0.05 filled');
  assert.equal(dn5Filled.totalCost, round2(100 * 0.05 - 100 * 0.05 * 0.001), 'cost ≈$5 minus rebate');
  console.log('  ✓ DOWN @ 0.05 fills, cost $5');

  // ── 5: Cancel unfilled ──
  engine.cancelUnfilled(engine.markets.get(slug));
  const cancelled = engine.orders.filter(o => o.slug === slug && o.status === 'CANCELLED');
  // DOWN ask 0.05 ≤ 0.101, so DOWN@0.10 also fills. Only UP@0.05 remains pending
  const cancelled2 = engine.orders.filter(o => o.slug === slug && o.status === 'CANCELLED');
  assert.equal(cancelled2.length, 1, '1 cancelled (UP@0.05 only)');
  console.log('  ✓ 1 unfilled cancelled');

  // ── 6: Resolution ──
  const cs2 = cs + 300;
  const slug2 = `btc-updown-5m-${cs2}`;
  engine.markets.set(slug2, {
    slug: slug2, asset: 'btc', conditionId: '0xc1', title: 'test2',
    windowStart: cs2, windowEnd: cs2 + 300, resolved: false, winner: null, tradingClosed: false, finalUpMax: 0.05, finalDownMax: 0.95,
    up: { tokenId: 'up-id', slug: slug2, asset: 'btc', outcome: 'UP', bid: 0.00, ask: 0.10, mid: 0.05, updatedAt: Date.now(), bookAsks: [] },
    down: { tokenId: 'down-id', slug: slug2, asset: 'btc', outcome: 'DOWN', bid: 0.90, ask: 0.95, mid: 0.925, updatedAt: Date.now(), bookAsks: [] },
  });
  engine.lastOrderWindow = null; engine.lastCancelWindow = null;
  engine.placeBuyOrders(engine.markets.get(slug2));
  // Fill all 4 orders
  engine.markets.get(slug2).up.ask = 0.05; engine.markets.get(slug2).down.ask = 0.05;
  engine.checkBuyFill(engine.markets.get(slug2));
  assert.equal(engine.orders.filter(o => o.slug === slug2 && o.status === 'FILLED').length, 4, 'all 4 filled');
  await engine.resolveWindow(engine.markets.get(slug2), engine.markets.get(slug2).windowEnd + 1);
  // UP lost, DOWN won
  const up010 = engine.orders.find(o => o.slug === slug2 && o.outcome === 'UP' && o.price === 0.10);
  const dn010 = engine.orders.find(o => o.slug === slug2 && o.outcome === 'DOWN' && o.price === 0.10);
  const dn005 = engine.orders.find(o => o.slug === slug2 && o.outcome === 'DOWN' && o.price === 0.05);
  assert.ok(up010.pnl < 0, "UP @ 0.10 lost");
  assert.ok(dn010.pnl > 80, 'DOWN @ 0.10 won big');
  assert.ok(dn005.pnl > 90, 'DOWN @ 0.05 won bigger');
  const expected = round2(-10 + 90 + 95 + (100 * 0.05 - 100 * 0.05)); // UP@0.05 = -$5, total = -10+90+95-5 = 170
  console.log(`  ✓ resolution P&L: $${engine.realizedPnl.toFixed(2)}`);

  console.log('✅ All tests passed');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });

function round2(v) { return Math.round(v * 100) / 100; }
