'use strict';
const assert = require('node:assert/strict');
const { BotEngine } = require('../engine');

async function setup(candles) {
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
      if (u.includes('klines')) return { ok: true, json: async () => candles };
      if (u.includes('ticker/price')) return { ok: true, json: async () => ({ price: '60000' }) };
      throw new Error('unexpected url ' + u);
    },
  });
  engine.binanceCandles = candles;
  return engine;
}

(async () => {
  const engine = await setup([]);

  // ── Flat sizing (no recovery/martingale) ──────────────────
  assert.equal(engine.nextShares(), 1000, 'flat 1000 shares on every buy');
  engine.losses = 5;
  assert.equal(engine.nextShares(), 1000, 'still flat 1000 shares after losses');

  // ── Entry: confidence >= 70% → buy signal side 1000 ───────
  const cs = Math.floor((Date.now() - 30000) / 1000 / 300) * 300; // ~30s into the window
  const slug = `btc-updown-5m-${cs}`;
  engine.entryWindow = null;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', ask: 0.55, bid: 0.50, mid: 0.52 },
    down: { tokenId: 'down-id', ask: 0.45, bid: 0.40, mid: 0.42 },
  });
  engine.signal = { score: 7, confidence: 0.80, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  engine.evaluateEntry();
  const pos = engine.positions.find(p => p.windowStart === cs && p.status === 'open');
  assert.ok(pos, 'entry fires at confidence >= 70%');
  assert.equal(pos.outcome, 'UP');
  assert.equal(pos.shares, 1000, 'flat 1000 shares');

  // ── Stop loss: after 240s, wait for price to come back to 0.20 ──
  // Before 240s elapsed: price below 0.20 must NOT sell (not armed yet).
  const slStart = Math.floor((Date.now() - 300000) / 1000 / 300) * 300;
  await engine.discoverMarket('btc', slStart);
  const slMarket = engine.markets.get(`btc-updown-5m-${slStart}`);
  slMarket.up.ask = 0.45; slMarket.up.bid = 0.42; slMarket.up.mid = 0.44;
  slMarket.down.ask = 0.55; slMarket.down.bid = 0.52; slMarket.down.mid = 0.54;
  engine.executeBuy(slMarket, 'UP', 0.44, 1000, slStart, slStart + 300);
  const slPos = engine.positions.find(p => p.slug === slMarket.slug && p.status === 'open');

  // Not yet 240s: price below 0.20 → arm only when elapsed >= 240, so no sell.
  slPos.windowStart = Math.floor(Date.now() / 1000) - 230;
  slMarket.up.ask = 0.15; slMarket.up.mid = 0.14;
  engine.evaluateExit();
  assert.ok(slPos.status === 'open', 'no sell before 240s even if price below 0.20');

  // Now 241s elapsed: price below 0.20 → arm (still hold, waiting to recover).
  slPos.windowStart = Math.floor(Date.now() / 1000) - 241;
  engine.evaluateExit();
  assert.ok(slPos.status === 'open', 'below 0.20 after 240s → armed, still holding (waiting for recovery)');
  assert.equal(slPos.slArmed, true, 'stop-loss armed');

  // Price comes back to 0.20 → sell as stop loss.
  slMarket.up.ask = 0.20; slMarket.up.mid = 0.19;
  engine.evaluateExit();
  const stopped = engine.resolvedPositions.find(p => p.exitReason === 'STOP_LOSS');
  assert.ok(stopped, 'stop-loss sells once price recovers to 0.20');
  assert.equal(stopped.exitPrice, 0.20, 'sold at the stop-loss price 0.20');

  // ── Resolution: last-2s CLOB, no fallback ─────────────────
  const start = Math.floor((Date.now() - 600000) / 1000 / 300) * 300;
  await engine.discoverMarket('btc', start);
  const upMarket = engine.markets.get(`btc-updown-5m-${start}`);
  upMarket.up.ask = 0.04; upMarket.up.bid = 0.03; upMarket.up.mid = 0.035;
  engine.executeBuy(upMarket, 'UP', 0.035, 1000, start, start + 300);
  upMarket.finalUpMax = 0.92; upMarket.finalDownMax = 0.08;
  engine.resolveByBinance();
  const resolved = engine.resolvedPositions.find(p => p.windowStart === start);
  assert.ok(resolved, 'position should have resolved');
  assert.equal(resolved.won, true, 'UP won: final UP price 0.92 >= 0.90');

  // ── Key bug fix test: unchanged book within final 2s ───────
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  downMarket.down.bid = 0.90; downMarket.down.ask = 0.92; downMarket.down.mid = 0.91;
  downMarket.up.bid = 0.08; downMarket.up.ask = 0.10; downMarket.up.mid = 0.09;
  engine.executeBuy(downMarket, 'DOWN', 0.91, 1000, start2, start2 + 300);

  const downToken = downMarket.down;
  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'capture fires even on unchanged book within final 2s');
  assert.equal(downMarket.finalCaptureAt > 0, true, 'capture timestamp set');

  engine.applyBook(downToken, [{ price: '0.90', size: '500' }], [{ price: '0.92', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.91, 'unchanged book still captured');

  engine.applyBook(downToken, [{ price: '0.95', size: '500' }], [{ price: '0.97', size: '500' }]);
  assert.equal(downMarket.finalDownMax, 0.96, 'spike captured on new book change');

  downMarket.finalUpMax = 0.05;
  engine.resolveByBinance();
  const resolved2 = engine.resolvedPositions.find(p => p.windowStart === start2);
  assert.ok(resolved2, 'down position should resolve');
  assert.equal(resolved2.resolvedWinner, 'DOWN', 'DOWN won');
  assert.equal(resolved2.won, true);

  console.log('✅ Pumpfun smoke: flat 1000 + conf>=70% + stop-loss 0.20 after 240s + last-2s CLOB OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
