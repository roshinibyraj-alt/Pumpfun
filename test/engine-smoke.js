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

  // ── Flat $100 sizing: shares = round(dollar / price) ──────
  assert.equal(engine.sharesFor(0.5), 200, '$100 @ 0.50 = 200 shares');
  assert.equal(engine.sharesFor(0.9), 111, '$100 @ 0.90 = 111 shares');
  assert.equal(engine.sharesFor(0.4), 250, '$100 @ 0.40 = 250 shares');

  // ── Initial entry + one rebuy via evaluateEntry ────────────
  const cs = Math.floor((Date.now() - 30000) / 1000 / 300) * 300; // ~30s into the window
  const slug = `btc-updown-5m-${cs}`;
  engine.entryWindow = null;
  engine.markets.set(slug, {
    slug, asset: 'btc', conditionId: '0xc0', windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: 'up-id', ask: 0.55, bid: 0.50, mid: 0.52 },
    down: { tokenId: 'down-id', ask: 0.45, bid: 0.40, mid: 0.42 },
  });
  engine.signal = { score: 7, confidence: 1, lean: 'UP', updatedAt: Date.now(), indicators: {} };
  engine.signalStreak = 999;

  // 100% confidence + streak → INITIAL buy UP at 0.55
  engine.evaluateEntry();
  let pos = engine.positions.find(p => p.windowStart === cs && p.kind === 'INITIAL');
  assert.ok(pos, 'initial UP entry fires at 100% confidence');
  assert.equal(pos.outcome, 'UP');
  assert.equal(pos.shares, 182, '$100 @ 0.55 ≈ 182 shares');

  // Held UP side ask dips below 0.40 → one REBUY of the same side
  engine.markets.get(slug).up.ask = 0.35;
  engine.markets.get(slug).up.mid = 0.34;
  engine.evaluateEntry();
  const rebuy = engine.positions.find(p => p.windowStart === cs && p.kind === 'REBUY');
  assert.ok(rebuy, 'rebuy fires when held side ask < 0.40');
  assert.equal(rebuy.outcome, 'UP');
  assert.equal(engine.rebuyDone.has(cs), true, 'rebuy marked done for the window');

  // Second dip below 0.40 → NO second rebuy (one per window)
  engine.markets.get(slug).up.ask = 0.30;
  engine.evaluateEntry();
  assert.equal(engine.positions.filter(p => p.windowStart === cs).length, 2, 'exactly initial + one rebuy');

  // ── Resolution: last-2s CLOB, no fallback ─────────────────
  // Force the open legs to an already-ended window so resolution settles them.
  for (const p of engine.positions) {
    if (p.windowStart === cs && p.status === 'open') p.windowEnd = Date.now() / 1000 - 1;
  }
  const market = engine.markets.get(slug);
  market.finalUpMax = 0.94; market.finalDownMax = 0.06;
  engine.resolveByBinance();
  const w1 = engine.resolvedPositions.find(p => p.windowStart === cs && p.kind === 'INITIAL');
  const w2 = engine.resolvedPositions.find(p => p.windowStart === cs && p.kind === 'REBUY');
  assert.ok(w1 && w2, 'both legs resolve');
  assert.equal(w1.won && w2.won, true, 'UP wins, both legs pay');

  // ── Key bug fix test: unchanged book within final 2s ───────
  const start2 = start - 300;
  await engine.discoverMarket('btc', start2);
  const downMarket = engine.markets.get(`btc-updown-5m-${start2}`);
  const downToken = downMarket.down;
  downToken.mid = 0.91;
  engine.executeBuy(downMarket, 'DOWN', 0.91, 111, start2, start2 + 300);

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

  console.log('✅ Pumpfun smoke: flat $100 + conf 100% + one rebuy + last-2s CLOB OK');
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e); process.exit(1); });
