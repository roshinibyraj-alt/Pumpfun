'use strict';
const assert = require('node:assert/strict');
const { BotEngine, config } = require('../engine');

async function setup() {
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
      if (u.includes('klines')) return { ok: true, json: async () => [] };
      if (u.includes('ticker/price')) return { ok: true, json: async () => ({ price: '60000' }) };
      throw new Error('unexpected url ' + u);
    },
  });
  return engine;
}

// Helper: set up a market for a specific window start
function makeMarket(engine, windowStart, upAsk, downAsk) {
  const slug = `btc-updown-5m-${windowStart}`;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc' + windowStart, windowStart, windowEnd: windowStart + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', slug, asset: 'btc', outcome: 'UP', ask: upAsk, bid: upAsk - 0.05, mid: upAsk - 0.025, updatedAt: Date.now() },
    down: { tokenId: 'down-id', slug, asset: 'btc', outcome: 'DOWN', ask: downAsk, bid: downAsk - 0.05, mid: downAsk - 0.025, updatedAt: Date.now() },
  });
  return slug;
}

(async () => {
  const engine = await setup();
  const BUDGET = config.FLAT_BUDGET; // 500

  // ── Flat $500 base ──
  assert.equal(engine.flatBudget, 500, 'base starts at $500');

  // ── Test 1: First signal → buy immediately at any price ──
  const cs1 = Math.floor((Date.now() - 60000) / 1000 / 300) * 300;
  // Override windowStartFor to return cs1
  engine.entryWindow = null;
  engine.lastWindowStart = null;
  const slug1 = makeMarket(engine, cs1, 0.75, 0.30);
  engine.signal = { score: 7, confidence: 0.80, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  // Patch windowStartFor for this test by overriding the position's windowStart
  const pos1 = { slug: slug1, asset: 'btc', conditionId: '0xc1', outcome: 'UP', tokenId: 'up-id',
    shares: Math.floor(BUDGET / 0.75), entryPrice: 0.75, cost: Math.floor(BUDGET / 0.75) * 0.75,
    fee: 0, totalCost: Math.floor(BUDGET / 0.75) * 0.75, status: 'open', openedAt: Date.now(),
    markPrice: 0.75, windowStart: cs1, windowEnd: cs1 + 300, signalConf: 0.80,
    signalScore: 7, signalIndicators: {}, betLabel: 'FIRST', exitReason: null, exitPrice: null, closedAt: null, pnl: null
  };
  // Direct test of executeBuy with betLabel
  engine.executeBuy(engine.markets.get(slug1), 'UP', 0.75, Math.floor(BUDGET / 0.75), cs1, cs1 + 300, 'FIRST');
  const posResult = engine.positions.find(p => p.betLabel === 'FIRST' && p.outcome === 'UP');
  assert.ok(posResult, 'first signal buys UP at 0.75');
  assert.equal(posResult.betLabel, 'FIRST', 'betLabel is FIRST');
  assert.equal(posResult.shares, Math.floor(BUDGET / 0.75), 'shares correct');
  console.log('  ✓ first signal immediate buy OK');

  // ── Test 2: Flip trigger — first entry > 0.60, price drops to 0.40 → sell + buy opposite 2x ──
  const cs2 = cs1 + 300;
  engine.entryWindow = null;
  engine.lastWindowStart = null;
  engine.flippedThisWindow = false;
  const slug2 = makeMarket(engine, cs2, 0.65, 0.35);
  // Direct buy at 0.65 (> 0.60)
  engine.executeBuy(engine.markets.get(slug2), 'UP', 0.65, Math.floor(BUDGET / 0.65), cs2, cs2 + 300, 'FIRST');
  const flipEntry = engine.positions.find(p => p.windowStart === cs2 && p.betLabel === 'FIRST');
  assert.ok(flipEntry, 'flip: first entry UP at 0.65');

  // Simulate UP price dropping to 0.40
  engine.markets.get(slug2).up.ask = 0.40;
  engine.markets.get(slug2).up.mid = 0.40;
  engine.markets.get(slug2).down.ask = 0.30;
  engine.markets.get(slug2).down.mid = 0.27;

  // Run evaluateExit — should trigger flip
  engine.evaluateExit();
  const closedFlip = engine.resolvedPositions.find(p => p.windowStart === cs2 && p.exitReason === 'FLIP_TRIGGER');
  assert.ok(closedFlip, 'flip: first position sold at FLIP_TRIGGER');
  const doubleUp = engine.positions.find(p => p.windowStart === cs2 && p.status === 'open' && p.betLabel === 'DOUBLE-UP');
  assert.ok(doubleUp, 'flip: double-up position opened');
  assert.equal(doubleUp.outcome, 'DOWN', 'flip: bought opposite side');
  assert.equal(doubleUp.shares, flipEntry.shares * 2, 'flip: 2x shares');
  assert.equal(engine.flippedThisWindow, true, 'flip: tracked');
  console.log('  ✓ flip trigger at 0.40 OK');

  // ── Test 3: Double-up stop loss at 0.40 ──
  const cs3 = cs2 + 300;
  engine.entryWindow = null;
  engine.lastWindowStart = null;
  engine.flippedThisWindow = false;
  const slug3 = makeMarket(engine, cs3, 0.50, 0.60);
  engine.executeBuy(engine.markets.get(slug3), 'DOWN', 0.60, 200, cs3, cs3 + 300, 'DOUBLE-UP');
  const slPos = engine.positions.find(p => p.windowStart === cs3 && p.betLabel === 'DOUBLE-UP');
  assert.ok(slPos, 'SL: double-up position created');

  // Price drops to 0.40 → stop loss fires
  engine.markets.get(slug3).down.ask = 0.40;
  engine.markets.get(slug3).down.mid = 0.40;
  engine.evaluateExit();
  const slClosed = engine.resolvedPositions.find(p => p.windowStart === cs3 && p.exitReason === 'DOUBLE-UP_STOP');
  assert.ok(slClosed, 'SL: double-up stopped at 0.40');
  console.log('  ✓ double-up stop loss at 0.40 OK');

  // ── Test 4: No flip if entry ≤ 0.60 ──
  const cs4 = cs3 + 300;
  engine.entryWindow = null;
  engine.lastWindowStart = null;
  engine.flippedThisWindow = false;
  const slug4 = makeMarket(engine, cs4, 0.50, 0.50);
  engine.executeBuy(engine.markets.get(slug4), 'UP', 0.50, 1000, cs4, cs4 + 300, 'FIRST');
  const noFlipPos = engine.positions.find(p => p.windowStart === cs4 && p.betLabel === 'FIRST');
  assert.ok(noFlipPos, 'no flip: first entry at 0.50 (≤ 0.60)');
  engine.markets.get(slug4).up.ask = 0.40;
  engine.markets.get(slug4).up.mid = 0.40;
  engine.evaluateExit();
  const noFlipClosed = engine.resolvedPositions.find(p => p.windowStart === cs4 && p.exitReason === 'FLIP_TRIGGER');
  assert.equal(noFlipClosed, undefined, 'no flip: entry at 0.50 should NOT trigger flip');
  const noFlipStill = engine.positions.find(p => p.windowStart === cs4 && p.status === 'open');
  assert.ok(noFlipStill, 'no flip: position still open (holds to resolution)');
  console.log('  ✓ no flip when entry ≤ 0.60 OK');

  // ── Test 5: No second flip (only one per window) ──
  const cs5 = cs4 + 300;
  engine.entryWindow = null;
  engine.lastWindowStart = null;
  engine.flippedThisWindow = false;
  const slug5 = makeMarket(engine, cs5, 0.70, 0.30);
  engine.executeBuy(engine.markets.get(slug5), 'UP', 0.70, Math.floor(BUDGET / 0.70), cs5, cs5 + 300, 'FIRST');
  const entry5 = engine.positions.find(p => p.windowStart === cs5 && p.betLabel === 'FIRST');
  // First flip
  engine.markets.get(slug5).up.ask = 0.40;
  engine.markets.get(slug5).up.mid = 0.40;
  engine.markets.get(slug5).down.ask = 0.30;
  engine.markets.get(slug5).down.mid = 0.27;
  engine.evaluateExit();
  assert.equal(engine.flippedThisWindow, true, 'no second flip: first flip happened');
  const double5 = engine.positions.find(p => p.windowStart === cs5 && p.status === 'open' && p.betLabel === 'DOUBLE-UP');
  assert.ok(double5, 'no second flip: double-up position exists');
  // Double-up drops to 0.40 → should trigger STOP, not another flip
  engine.markets.get(slug5).down.ask = 0.40;
  engine.markets.get(slug5).down.mid = 0.40;
  engine.evaluateExit();
  const stopped5 = engine.resolvedPositions.find(p => p.windowStart === cs5 && p.exitReason === 'DOUBLE-UP_STOP');
  assert.ok(stopped5, 'no second flip: double-up stopped (not another flip)');
  console.log('  ✓ max one flip per window OK');

  // ── Test 6: Resolution ──
  const cs6 = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  const slug6 = makeMarket(engine, cs6, 0.04, 0.95);
  engine.executeBuy(engine.markets.get(slug6), 'UP', 0.04, engine.sharesFor(0.04), cs6, cs6 + 300, 'FIRST');
  engine.markets.get(slug6).finalUpMax = 0.92;
  engine.markets.get(slug6).finalDownMax = 0.08;
  await engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === cs6 && p.exitReason === 'RESOLUTION');
  assert.ok(resolved, 'resolution: position resolves');
  assert.equal(resolved.won, true, 'UP won');
  console.log('  ✓ resolution OK');

  console.log('✅ All tests passed');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
