'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CricketEngine, parseMarketUrl, fee } = require('./engine.cjs');
const { metadata, loadMatch } = require('./markets.cjs');
function fixture() {
  let now = 100000;
  const engine = new CricketEngine(undefined, () => now);
  const market = { id: 'market', question: 'Australia vs England', closed: false, acceptingOrders: true,
    secondsDelay: 1, feeRate: 0.05, feeExponent: 1, feeKnown: true, tickSize: 0.01, minOrderSize: 5,
    outcomes: [{ id: 'aus', name: 'Australia', shares: 0, costBasis: 0, liquidationValue: 0 },
      { id: 'eng', name: 'England', shares: 0, costBasis: 0, liquidationValue: 0 }] };
  engine.data.matches.push({ id: 'match', closed: false, markets: [market] });
  const book = (id = 'aus', asks = [{ price: .5, size: 500 }], bids = [{ price: .49, size: 500 }]) => engine.book(id, bids, asks);
  book(); book('eng');
  const submit = (side = 'BUY', id = 'aus', requestId = `request-${engine.data.orders.length}`) => engine.submit({ outcomeId: id, side, requestId });
  const advance = (ms = 1000) => { now += ms; };
  return { engine, market, book, submit, advance };
}
test('only official Polymarket URLs accepted, no arbitrary requests', () => {
  assert.equal(parseMarketUrl('https://polymarket.com/sports/crint/crint-aus-gbr-2026-11-24'), 'crint-aus-gbr-2026-11-24');
  for (const url of ['http://polymarket.com/event/aaa', 'https://evil.com/event/aaa', 'https://polymarket.com.evil.com/event/aaa',
    'https://user:password@polymarket.com/event/aaa', 'https://polymarket.com:8000/event/aaa', 'bad'])
    assert.throws(() => parseMarketUrl(url));
});
test('buy waits full exchange delay AND a post-delay snapshot', () => {
  const f = fixture(), o = f.submit();
  assert.equal(f.engine.execute(o), false);
  assert.equal(f.engine.data.cash, 3000);
  f.advance(); assert.equal(f.engine.execute(o), false);
  f.book(); assert.equal(f.engine.execute(o), true);
  assert.equal(o.status, 'FILLED'); assert.equal(o.filledShares, 100);
  assert.equal(f.market.outcomes[0].costBasis, 51.25);
  assert.equal(f.engine.data.cash, 2948.75);
});
test('fills at changed execution prices, not tap-time asks', () => {
  const f = fixture(), o = f.submit(); f.advance();
  f.book('aus', [{ price: .52, size: 100 }]); f.engine.execute(o);
  assert.equal(o.averagePrice, .52);
});
test('market movement beyond slippage gives no fill', () => {
  const f = fixture(), o = f.submit(); f.advance();
  f.book('aus', [{ price: .6, size: 100 }]); f.engine.execute(o);
  assert.equal(o.status, 'UNFILLED'); assert.equal(f.engine.data.cash, 3000);
});
test('sweeps multiple levels and cancels unfilled remainder', () => {
  const f = fixture(), o = f.submit(); f.advance();
  f.book('aus', [{ price: .5, size: 20 }, { price: .51, size: 30 }, { price: .54, size: 400 }]);
  f.engine.execute(o); assert.equal(o.status, 'PARTIAL'); assert.equal(o.filledShares, 50);
  assert.ok(Math.abs(o.averagePrice - .506) < 1e-10);
  assert.equal(f.market.outcomes[0].shares, 50);
});
test('sell all uses held shares, fresh bids, exit fees and allocated cost basis', () => {
  const f = fixture(), buy = f.submit(); f.advance(); f.book(); f.engine.execute(buy);
  f.book('aus', [{ price: .61, size: 500 }], [{ price: .6, size: 500 }]);
  const sell = f.submit('SELL'); assert.equal(sell.requestedShares, 100);
  assert.equal(f.engine.execute(sell), false); f.advance();
  f.book('aus', [{ price: .61, size: 500 }], [{ price: .6, size: 500 }]); f.engine.execute(sell);
  assert.equal(sell.filledShares, 100); assert.equal(f.market.outcomes[0].shares, 0);
  assert.equal(sell.realizedPnl, 7.55); assert.equal(f.engine.data.cash, 3007.55);
  assert.equal(f.engine.data.totalFees, 2.45);
  assert.equal(f.engine.snapshot().equity, 3007.55);
});
test('partial sell retains proportional basis and remaining shares', () => {
  const f = fixture(), buy = f.submit(); f.advance(); f.book(); f.engine.execute(buy);
  const sell = f.submit('SELL'); f.advance();
  f.book('aus', [{ price: .5, size: 10 }], [{ price: .49, size: 25 }]); f.engine.execute(sell);
  assert.equal(sell.status, 'PARTIAL'); assert.equal(f.market.outcomes[0].shares, 75);
  assert.equal(f.market.outcomes[0].costBasis, 38.4375);
});
test('duplicate request is idempotent and pending outcome cannot double submit', () => {
  const f = fixture(), order = f.submit('BUY', 'aus', 'unique-id');
  assert.equal(f.submit('BUY', 'aus', 'unique-id').id, order.id);
  assert.throws(() => f.submit(), /pending/);
  assert.doesNotThrow(() => f.submit('BUY', 'eng'));
});
test('no fake fills on stale data or missing fee/delay metadata', () => {
  const f = fixture(); f.advance(6000); assert.throws(() => f.submit(), /stale/);
  f.book(); f.market.feeKnown = false; assert.throws(() => f.submit(), /Fee/);
  f.market.feeKnown = true; f.market.secondsDelay = null; assert.throws(() => f.submit(), /delay/);
});
test('concurrent buys reserve cash, released when no fill', () => {
  const f = fixture(); f.engine.data.cash = 60; const o = f.submit();
  assert.throws(() => f.submit('BUY', 'eng'), /cash/);
  f.advance(); f.book('aus', [{ price: .9, size: 100 }]); f.engine.execute(o);
  assert.doesNotThrow(() => f.submit('BUY', 'eng'));
});
test('liquidation equity values bids and fees, not mid or ask', () => {
  const f = fixture(), o = f.submit(); f.advance(); f.book(); f.engine.execute(o);
  const s = f.engine.snapshot();
  const value = 49 - fee(.49, 100, f.market);
  assert.ok(Math.abs(s.equity - (2948.75 + value)) < 1e-7);
  assert.equal(s.matches[0].markets[0].outcomes[0].averageEntry, .5125);
  assert.ok(Math.abs(s.equity - 3000 - f.engine.data.realizedPnl
    - s.matches[0].markets[0].outcomes[0].unrealizedPnl) < 1e-7);
});
test('official settlement pays once, supports equal splits and preserves old match accounting', () => {
  const f = fixture(), o = f.submit(); f.advance(); f.book(); f.engine.execute(o);
  assert.equal(f.engine.settle(f.market, [.5, .5]), true);
  assert.equal(f.engine.data.cash, 2998.75); assert.equal(f.engine.data.realizedPnl, -1.25);
  assert.equal(f.engine.settle(f.market, [.5, .5]), false);
});
test('invalid payout cannot fabricate winner', () => {
  const f = fixture(); assert.equal(f.engine.settle(f.market, [1, 1]), false);
  assert.equal(f.engine.settle(f.market, [0, 0]), false); assert.equal(f.market.settled, undefined);
});
test('restart restores holdings and interrupts pending requests without replay', () => {
  const f = fixture(), buy = f.submit(); f.advance(); f.book(); f.engine.execute(buy); f.submit('SELL');
  const restored = new CricketEngine(JSON.parse(JSON.stringify(f.engine.data)));
  assert.equal(restored.data.cash, 2948.75); assert.equal(restored.locate('aus').outcome.shares, 100);
  assert.equal(restored.data.orders[0].status, 'INTERRUPTED');
  assert.equal(restored.snapshot().matches[0].markets[0].outcomes[0].quoteFresh, false);
});
test('missing fee schedule is unknown rather than fee-free', () => {
  assert.equal(metadata({ feesEnabled: true }).feeKnown, false);
  assert.equal(metadata({ feesEnabled: false }).feeKnown, true);
  assert.equal(metadata({ feesEnabled: false }).feeRate, 0);
  assert.equal(metadata({}).secondsDelay, null);
});
test('event URL loads every supported submarket with IDs and delay', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'event', slug: 'crint-aus-gbr', title: 'Australia vs England',
    tags: [{ slug: 'cricket' }], markets: ['one', 'two'].map(id => ({ id, enableOrderBook: true,
      clobTokenIds: JSON.stringify([id + '-a', id + '-b']), outcomes: '["Australia","England"]', question: id,
      secondsDelay: 1, feesEnabled: true, feeSchedule: { rate: .05, exponent: 1 }, acceptingOrders: true })) }] });
  try {
    const match = await loadMatch('https://polymarket.com/event/crint-aus-gbr');
    assert.equal(match.markets.length, 2); assert.equal(match.markets[0].outcomes[1].id, 'one-b');
    assert.equal(match.markets[0].secondsDelay, 1); assert.equal(match.markets[0].feeRate, .05);
  } finally { global.fetch = original; }
});
