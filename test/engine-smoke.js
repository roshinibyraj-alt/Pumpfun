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
  const cs = Math.floor((Date.now() - 30000) / 1000 / 300) * 300; // ~30s into the window
  const slug = `btc-updown-5m-${cs}`;
  engine.entryWindow = null;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', ask: 0.55, bid: 0.50, mid: 0.52 },
    down: { tokenId: 'down-id', ask: 0.45, bid: 0.40, mid: 0.42 },
  });

  // ── Flat sizing ────────────────────────────────────────────
  assert.equal(engine.nextShares(), 1000, 'flat 1000 shares on every buy');

  // ── Entry: confidence above 0.65 + streak → buy UP 1000 ────
  engine.signal = { score: 7, confidence: 0.80, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  engine.signalStreak = 999;
  engine.evaluateEntry();
  let pos = engine.positions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(pos, 'UP entry fires when conf > 0.65');
  assert.equal(pos.outcome, 'UP');
  assert.equal(pos.shares, 1000, 'flat 1000 shares');

  // ── Confidence goes neutral → sell immediately ─────────────
  engine.signal = { score: 0, confidence: 0, lean: 'NEUTRAL', updatedAt: Date.now(), indicators: {} };
  engine.markets.get(slug).up.ask = 0.53; engine.markets.get(slug).up.bid = 0.50; engine.markets.get(slug).up.mid = 0.51;
  engine.evaluateExit();
  assert.equal(engine.positions.filter(p => p.status === 'open').length, 0, 'neutral sells the held position');
  const sold = engine.resolvedPositions.find(p => p.windowStart === cs && p.exitReason === 'NEUTRAL');
  assert.ok(sold, 'sell recorded with NEUTRAL reason');

  // ── Signal returns → re-enter ──────────────────────────────
  engine.signal = { score: -7, confidence: 0.90, lean: 'DOWN', updatedAt: Date.now(), indicators: {} };
  engine.signalStreak = 999;
  engine.evaluateEntry();
  pos = engine.positions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(pos, 're-entry fires after neutral sell when signal returns');
  assert.equal(pos.outcome, 'DOWN', 're-enters on the new signal side');

  // ── Resolution: last-2s CLOB, no fallback ─────────────────
  for (const p of engine.positions) {
    if (p.windowStart === cs && p.status === 'open') p.windowEnd = Date.now() / 1000 - 1;
  }
  const market = engine.markets.get(slug);
  market.finalUpMax = 0.06; market.finalDownMax = 0.94;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(resolved || engine.positions.filter(p => p.windowStart === cs && p.status === 'open').length === 0, 're-entry resolves');
  assert.equal(engine.positions.filter(p => p.windowStart === cs && p.status === 'open').length, 0, 'no open re-entry after resolution');

  // ── Key bug fix test: unchanged book within final 2s ───────
  const start2 = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  const downToken = downMarket.down;
  downToken.mid = 0.91;
  engine.executeBuy(downMarket, 'DOWN', 0.91, 1000, start2, start2 + 300);

  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'unchanged book still captured');

  engine.applyBook(downToken, [{ price: '0.95', size: '500' }], [{ price: '0.97', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.96, 'spike captured on new book change');

  downMarket.finalUpMax = 0.05;
  engine.resolveByBinance();
  const resolved2 = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolved2, 'down position should resolve');
  assert.equal(resolved2.resolvedWinner, 'DOWN');
  assert.equal(resolved2.won, true);

  console.log('✅ Pumpfun smoke: conf>0.65 buy 1000, neutral sell, re-enter, last-2s CLOB OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
