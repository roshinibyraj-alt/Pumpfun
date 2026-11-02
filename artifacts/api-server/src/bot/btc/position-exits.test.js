'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProbabilityBot } = require('./probability-bot');
const { recoverExpiredPositions, resolvedPayout } = require('./position-exits');

function resolved(overrides = {}) {
  return { id: 'old-market', closed: true, umaResolutionStatus: 'resolved',
    outcomes: '["Up","Down"]', outcomePrices: '["0","1"]', clobTokenIds: '["old-up","old-down"]', ...overrides };
}

function expired(overrides = {}) {
  return { id: 'expired-up', marketId: 'old-market', tokenId: 'old-up', side: 'UP',
    status: 'OPEN', shares: 100, totalCost: 45, windowEnd: 300_000,
    lastOutcomeBid: 0.01, lastOutcomeBidAt: 291_094, ...overrides };
}

function bot(options = {}) {
  return new ProbabilityBot({
    now: () => 310_000, fetchMarketDetails: async () => resolved(),
    fetchBook: async () => { throw new Error('Original CLOB book unavailable'); },
    priceFeed: { start() {}, snapshot() { return { status: 'live', ageMs: 1 }; } },
    ...options,
  });
}

test('final payout requires the original token and confirmed exact binary resolution', () => {
  const trade = expired();
  assert.equal(resolvedPayout(resolved(), trade), 0);
  assert.equal(resolvedPayout(resolved(), expired({ tokenId: 'old-down', side: 'DOWN' })), 1);
  for (const change of [
    { id: 'next-market' }, { closed: false }, { umaResolutionStatus: 'proposed' },
    { outcomePrices: '["0.01","0.99"]' }, { outcomePrices: '["1","1"]' },
    { outcomePrices: 'malformed' }, { clobTokenIds: '["different-up","different-down"]' },
  ]) assert.equal(resolvedPayout(resolved(change), trade), null);
});

test('expired stale-close lots recover from original-market resolution, not next-window quotes', async () => {
  let marketRequests = 0;
  let bookRequests = 0;
  const paper = bot({
    fetchMarketDetails: async () => { marketRequests++; return resolved(); },
    fetchBook: async () => { bookRequests++; throw new Error('No book'); },
  });
  paper.market = { id: 'next-market' };
  paper.quotes.UP = { bestBid: 0.99, updatedAt: 310_000 };
  paper.trades = [expired(), expired({ id: 'second-lot' })];
  paper.processPositionExits(310_000);
  assert.ok(paper.trades.every(trade => trade.status === 'OPEN'));
  await recoverExpiredPositions(paper, 310_000);
  assert.equal(marketRequests, 1);
  assert.equal(bookRequests, 0);
  assert.ok(paper.trades.every(trade =>
    trade.finalOutcome === 'MARKET_RESOLUTION' && trade.closePrice === 0 && trade.exitFees === 0));
  const cash = paper.cash;
  await recoverExpiredPositions(paper, 310_000);
  assert.equal(paper.cash, cash);
  assert.equal(marketRequests, 1);
});

test('unresolved expired lots use a newly fetched own-token bid and share one book request', async () => {
  const tokens = [];
  const paper = bot({
    fetchMarketDetails: async () => resolved({ umaResolutionStatus: 'proposed' }),
    fetchBook: async token => { tokens.push(token); return { bids: [{ price: 0.64, size: 1000 }], asks: [] }; },
  });
  paper.trades = [expired(), expired({ id: 'second-lot' })];
  await recoverExpiredPositions(paper, 310_000);
  assert.deepEqual(tokens, ['old-up']);
  assert.ok(paper.trades.every(trade => trade.finalOutcome === 'WINDOW_RECOVERY_EXIT'));
  assert.ok(Math.abs(paper.trades[0].exitFees - 1.6128) < 1e-9);
  assert.match(paper.trades[0].settlementSource, /not a historical closing-price claim/);
});

test('missing market data stays explicitly pending and retries without fabricating a payout', async () => {
  let now = 310_000;
  let available = false;
  let attempts = 0;
  const paper = bot({
    now: () => now,
    fetchMarketDetails: async () => { attempts++; if (available) return resolved(); throw new Error('Gamma unavailable'); },
  });
  paper.trades = [expired()];
  await recoverExpiredPositions(paper, now);
  assert.equal(paper.trades[0].status, 'OPEN');
  assert.equal(paper.trades[0].settlementStatus, 'AWAITING_SETTLEMENT');
  assert.equal(paper.snapshot().paperAccount.awaitingSettlement, 1);
  assert.equal(paper.cash, 10_000);
  now += 9_000;
  await recoverExpiredPositions(paper, now);
  assert.equal(attempts, 1);
  available = true;
  now += 1_000;
  await recoverExpiredPositions(paper, now);
  assert.equal(attempts, 2);
  assert.equal(paper.trades[0].status, 'SETTLED');
  assert.equal(paper.trades[0].settlementStatus, 'SETTLED');
  assert.equal(paper.trades[0].settlementError, null);
});

test('expired recovery still runs if discovering the current market fails', async () => {
  const paper = bot({ fetchMarket: async () => { throw new Error('Current market unavailable'); } });
  paper.trades = [expired()];
  await paper.tick();
  assert.equal(paper.trades[0].finalOutcome, 'MARKET_RESOLUTION');
  assert.match(paper.error, /Current market unavailable/);
});
