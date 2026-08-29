'use strict';
// Reproduces the 16:25 bug: a transient high-confidence UP blip must NOT fire,
// a persistent high-confidence DOWN signal must fire after SIGNAL_CONFIRM_N holds.
const { BotEngine } = require('../engine');

// ── Build a market so tryBuy/executeBuy can run ──
const TOKEN_UP = 't-up', TOKEN_DOWN = 't-down';
const cs = Math.floor(Date.now() / 1000 / 300) * 300;

function makeCandles(direction) {
  // openTime aligned to window start; strong move for UP (+delta), down for DOWN
  const base = 90000;
  const closes = direction === 'UP' ? [90000, 90400, 90800, 91200, 91600, 92000, 92400]
    : direction === 'DOWN' ? [90000, 89600, 89200, 88800, 88400, 88000, 87600]
    : [90000, 90000, 90000, 90000, 90000, 90000, 90000];
  return closes.map((c, i) => ({
    openTime: cs - 60 + i * 60, open: i === 0 ? 90000 : closes[i - 1],
    high: Math.max(c, closes[i - 1] || c), low: Math.min(c, closes[i - 1] || c),
    close: c, volume: 1000,
  }));
}

(async () => {
  const engine = new BotEngine({ fetchImpl: async () => { throw new Error('no network'); }, onLog: l => console.log('  [log]', l) });
  engine.entryWindow = 0;
  // inject market
  engine.markets.set(cs, {
    slug: `btc-updown-5m-${cs}`, windowStart: cs, windowEnd: cs + 300,
    resolved: false, tradingClosed: false,
    up: { tokenId: TOKEN_UP, ask: 0.5, mid: 0.5, bid: 0.5 },
    down: { tokenId: TOKEN_DOWN, ask: 0.5, mid: 0.5, bid: 0.5 },
  });
  engine.tokens.set(TOKEN_UP, { tokenId: TOKEN_UP, ...engine.markets.get(cs).up });
  engine.tokens.set(TOKEN_DOWN, { tokenId: TOKEN_DOWN, ...engine.markets.get(cs).down });

  let upFired = 0, downFired = 0;
  const origExecute = engine.executeBuy.bind(engine);
  engine.executeBuy = (market, outcome, price, shares, ws, we) => {
    if (outcome === 'UP') upFired++; else downFired++;
  };

  console.log('STEP 1: transient UP blip (2 evals) then persistent DOWN ...');
  engine.binanceCandles = makeCandles('UP');
  for (let i = 0; i < 2; i++) { engine.computeSignal(); engine.evaluateEntry(); }
  console.log('  after blip: streak=', engine.signalStreak, 'lean=', engine.signal.lean, 'conf=', engine.signal.confidence.toFixed(2));

  engine.binanceCandles = makeCandles('DOWN');
  for (let i = 0; i < 30; i++) { engine.computeSignal(); engine.evaluateEntry(); }

  console.log('STEP 2 result: UP fired =', upFired, '| DOWN fired =', downFired);
  if (upFired > 0) { console.log('✗ FAIL: transient UP blip fired a trade'); process.exit(1); }
  if (downFired < 1) { console.log('✗ FAIL: persistent DOWN signal never fired (streak=', engine.signalStreak, ')'); process.exit(1); }

  console.log('✔ PASS: blip blocked, persistent DOWN fired after confirmation');
  process.exit(0);
})().catch(e => { console.error('✗ exception:', e); process.exit(1); });
