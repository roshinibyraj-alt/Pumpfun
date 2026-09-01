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

  // ── Binary sizing: win → $500, loss → $1 ─
  assert.equal(engine.flatBudget, 500, 'base starts at $500');
  assert.equal(engine.sharesFor(0.50), Math.floor(500 / 0.50), 'budget $500 / price');
  assert.equal(engine.sharesFor(0.70), Math.floor(500 / 0.70), 'budget $500 / price');
  // loss → $1
  engine.adjustBudget(false); assert.equal(engine.flatBudget, 1, '$1 after loss');
  engine.adjustBudget(false); assert.equal(engine.flatBudget, 1, 'stays $1 after consecutive loss');
  // win → $500
  engine.adjustBudget(true);  assert.equal(engine.flatBudget, 500, '$500 after win');
  engine.adjustBudget(true);  assert.equal(engine.flatBudget, 500, 'stays $500 after consecutive win');
  // loss then win cycle
  engine.adjustBudget(false); assert.equal(engine.flatBudget, 1, '$1 after loss');
  engine.adjustBudget(true);  assert.equal(engine.flatBudget, 500, '$500 after win');
  engine.flatBudget = BUDGET;

  // ── Entry: confidence >= 70% → buy signal side $500 worth ─
  const cs = Math.floor((Date.now() - 30000) / 1000 / 300) * 300; // ~30s in
  const slug = `btc-updown-5m-${cs}`;
  engine.entryWindow = null;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', ask: 0.70, bid: 0.65, mid: 0.67 },
    down: { tokenId: 'down-id', ask: 0.30, bid: 0.25, mid: 0.27 },
  });
  engine.signal = { score: 7, confidence: 0.80, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  engine.evaluateEntry();
  const pos = engine.positions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(pos, 'entry fires at confidence >= 70%');
  assert.equal(pos.outcome, 'UP');
  assert.equal(pos.shares, Math.floor(BUDGET / 0.70), 'shares = $budget / entry price');

  // ── One trade per window: second buy attempt rejected ─────
  engine.signal = { score: -7, confidence: 0.85, lean: 'DOWN', updatedAt: Date.now(), indicators: {} };
  engine.evaluateEntry();
  const buys = engine.positions.filter(p => p.windowStart === cs);
  assert.equal(buys.length, 1, 'at most one trade per window');

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

  console.log('✅ Pumpfun smoke: binary sizing (win→$500, loss→$1) + conf>=70% + 1 trade/window + no SL OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
