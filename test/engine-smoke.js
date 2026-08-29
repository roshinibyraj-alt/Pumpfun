'use strict';
const assert = require('node:assert/strict');
const { BotEngine } = require('../engine');

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
  const start = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  const end = start + 300;
  await engine.discoverMarket('btc', start);

  // Base size 1000; after one loss, martingale 1.5x -> 1500 shares
  assert.equal(engine.nextShares(), 1000, 'base 1000 shares');
  engine.consecutiveLosses = 1;
  assert.equal(engine.nextShares(), 1500, '1.5x martingale after one loss');

  // Build an open UP position
  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, 1000, start, end);

  // Final 2s: UP touched 0.94 in the last 2s -> UP wins, martingale resets
  upMarket.finalUpMax = 0.94;
  upMarket.finalDownMax = 0.06;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position should resolve');
  assert.equal(resolved.resolvedWinner, 'UP', 'UP wins because final price >= 0.90');
  assert.equal(resolved.won, true);
  assert.equal(engine.consecutiveLosses, 0, 'win resets martingale counter');

  // A DOWN loss: DOWN did NOT reach 0.90, UP higher in final 2s -> DOWN loses, martingale increments
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  downMarket.down.ask = 0.60; downMarket.down.bid = 0.58; downMarket.down.mid = 0.59;
  engine.executeBuy(downMarket, 'DOWN', 0.59, 1000, start2, start2 + 300);
  downMarket.finalUpMax = 0.08;
  downMarket.finalDownMax = 0.20; // DOWN highest in final 2s but far below 0.90
  engine.resolveByBinance();
  const resolved2 = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolved2, 'down position should resolve');
  assert.equal(resolved2.resolvedWinner, 'DOWN', 'DOWN is highest final-2s price -> wins');
  assert.equal(resolved2.won, true);
  assert.equal(engine.consecutiveLosses, 0, 'down won -> still 0 losses');

  console.log('✅ Pumpfun smoke: last-2s CLOB resolution + 1.5x martingale OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
