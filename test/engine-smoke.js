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

(async () => {
  const engine = await setup();
  const BUDGET = config.FLAT_BUDGET; // 500

  // ── Flat $500 base (no martingale, no binary sizing) ─
  assert.equal(engine.flatBudget, 500, 'base starts at $500');
  assert.equal(engine.sharesFor(0.50), Math.floor(500 / 0.50), 'budget $500 / price');
  assert.equal(engine.sharesFor(0.70), Math.floor(500 / 0.70), 'budget $500 / price');
  // stays flat regardless of wins/losses — flat bet
  assert.equal(engine.flatBudget, 500, 'flat $500 after loss');
  assert.equal(engine.flatBudget, 500, 'flat $500 after win');

  // ── Pullback entry: signal → pending → buy when price ≤ 0.50 ─
  const cs = Math.floor((Date.now() - 30000) / 1000 / 300) * 300;
  const slug = `btc-updown-5m-${cs}`;
  engine.entryWindow = null;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', ask: 0.70, bid: 0.65, mid: 0.67 },
    down: { tokenId: 'down-id', ask: 0.30, bid: 0.25, mid: 0.27 },
  });
  // Step 1: signal fires → pending set, no buy yet
  engine.signal = { score: 7, confidence: 0.80, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  engine.evaluateEntry();
  assert.ok(engine.pendingSignal, 'pending signal set after confidence >= 70%');
  assert.equal(engine.pendingSignal.side, 'UP');
  assert.equal(engine.positions.find(p => p.windowStart === cs && p.status === 'open'), undefined, 'no buy yet — waiting for price ≤ 0.50');
  // Step 2: price still above 0.50 → no entry
  engine.checkPendingEntry();
  assert.ok(engine.pendingSignal, 'still pending — UP ask 0.70 > 0.50');
  assert.equal(engine.positions.find(p => p.windowStart === cs && p.status === 'open'), undefined, 'still no buy');
  // Step 3: price drops to ≤ 0.50 → executes buy
  engine.markets.get(slug).up.ask = 0.48;
  engine.checkPendingEntry();
  const pos = engine.positions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(pos, 'entry fires when price drops to ≤ 0.50');
  assert.equal(pos.outcome, 'UP');
  assert.equal(pos.shares, Math.floor(BUDGET / 0.48), 'shares = $budget / entry price (0.48)');
  assert.equal(engine.pendingSignal, null, 'pending cleared after buy');
  // Step 4: one trade per window — second buy rejected
  engine.signal = { score: -7, confidence: 0.85, lean: 'DOWN', updatedAt: Date.now(), indicators: {} };
  engine.evaluateEntry();
  engine.pendingSignal = { side: 'DOWN', confidence: 0.85, windowStart: cs, windowEnd: cs + 300, startedAt: Date.now() };
  engine.markets.get(slug).down.ask = 0.30;
  engine.checkPendingEntry();
  const buys = engine.positions.filter(p => p.windowStart === cs);
  assert.equal(buys.length, 1, 'at most one trade per window');
  engine.pendingSignal = null;

  // ── No stop loss: position holds even if price crashes ───
  const slStart = Math.floor((Date.now() - 300000) / 1000 / 300) * 300;
  await engine.discoverMarket('btc', slStart);
  const slMarket = engine.markets.get(`btc-updown-5m-${slStart}`);
  slMarket.up.ask = 0.50; slMarket.up.bid = 0.45; slMarket.up.mid = 0.47;
  slMarket.down.ask = 0.50; slMarket.down.bid = 0.45; slMarket.down.mid = 0.47;
  engine.executeBuy(slMarket, 'UP', 0.47, engine.sharesFor(0.47), slStart, slStart + 300);
  const slPos = engine.positions.find(p => p.slug === slMarket.slug && p.status === 'open');
  // price crashes below any stop level and window well past 240s
  slPos.windowStart = Math.floor(Date.now() / 1000) - 260;
  slMarket.up.ask = 0.05; slMarket.up.bid = 0.04; slMarket.up.mid = 0.045;
  engine.evaluateExit();
  assert.equal(slPos.status, 'open', 'NO stop loss — position holds even after price crashes');
  assert.equal(engine.resolvedPositions.find(p => p.exitReason === 'STOP_LOSS') == null, true, 'no STOP_LOSS exit exists');

  // ── Resolution: hold to resolution, no intra-window sell ─
  const start = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  await engine.discoverMarket('btc', start);
  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, engine.sharesFor(0.035), start, start + 300);
  upMarket.finalUpMax = 0.92; upMarket.finalDownMax = 0.08;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position resolves at window end');
  assert.equal(resolved.won, true, 'UP won: final UP price 0.92 >= 0.90');
  assert.equal(resolved.exitReason, 'RESOLUTION', 'resolved — not stopped out');

  console.log('✅ Pumpfun smoke: flat $500 + pullback entry + conf>=70% + 1 trade/window + no SL OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
