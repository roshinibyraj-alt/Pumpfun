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

  // Martingale sizing
  assert.equal(engine.nextShares(), 1000, 'base 1000 shares');
  engine.consecutiveLosses = 1;
  assert.equal(engine.nextShares(), 1500, '1.5x martingale after one loss');

  // Build a UP position and resolve via final-2s CLOB
  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, 1000, start, end);
  upMarket.finalUpMax = 0.94; upMarket.finalDownMax = 0.06;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position should resolve');
  assert.equal(resolved.resolvedWinner, 'UP', 'UP wins');
  assert.equal(engine.consecutiveLosses, 0, 'win resets martingale');

  // ── Key bug fix test: unchanged book within final 2s ───────
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  const downToken = downMarket.down;
  downToken.mid = 0.91;
  engine.executeBuy(downMarket, 'DOWN', 0.91, 1000, start2, start2 + 300);

  // applyBook with same prices — unchanged book. Before the fix this
  // would skip the final-2s capture. After the fix, it must capture.
  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'unchanged book still captured');

  // Spike mid to 0.96 via a new book
  engine.applyBook(downToken, [{ price: '0.95', size: '500' }], [{ price: '0.97', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.96, 'spike captured on new book change');

  downMarket.finalUpMax = 0.05;
  engine.resolveByBinance();
  const resolved2 = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolved2, 'down position should resolve');
  assert.equal(resolved2.resolvedWinner, 'DOWN');
  assert.equal(resolved2.won, true);

  console.log('✅ Pumpfun smoke: martingale + last-2s CLOB + unchanged-book capture fix OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
