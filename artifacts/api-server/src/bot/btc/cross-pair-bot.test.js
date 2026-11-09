'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CrossPairBot } = require('./cross-pair-bot.cjs');
const config = require('./cross-pair-config.cjs');

function fixture({
  quoteSize = 1000,
  btcDownSize = quoteSize,
  ethUpSize = quoteSize,
  ethDownSize = quoteSize,
  askPrice = 0.25,
  misalignEth = false,
} = {}) {
  let now = config.WINDOW_MS * 100 + 10_000;
  const marketsById = new Map();
  const getMarket = async id => marketsById.get(String(id)) || {
    id: String(id),
    closed: false,
    umaResolutionStatus: 'proposed',
  };
  const marketFor = (asset, start) => {
    const id = `${asset.toLowerCase()}-${start}`;
    const tokens = {
      UP: `${asset.toLowerCase()}-up-${start}`,
      DOWN: `${asset.toLowerCase()}-down-${start}`,
    };
    const market = {
      id,
      conditionId: `condition-${id}`,
      asset,
      slug: `${asset.toLowerCase()}-updown-15m-${start / 1000}`,
      title: `${asset} Up or Down`,
      start: asset === 'ETH' && misalignEth ? start + config.WINDOW_MS : start,
      end: start + config.WINDOW_MS,
      tokens,
      raw: {
        id,
        feesEnabled: true,
        feeSchedule: { rate: 0.07, exponent: 1 },
        clobTokenIds: [tokens.UP, tokens.DOWN],
        outcomes: ['Up', 'Down'],
      },
    };
    marketsById.set(String(id), {
      ...market.raw,
      id,
      closed: false,
      umaResolutionStatus: 'proposed',
      outcomePrices: ['0.5', '0.5'],
    });
    return market;
  };
  const marketData = {
    getBtcMarket: async start => marketFor('BTC', start),
    getEthMarket: async start => marketFor('ETH', start),
    getBook: async tokenId => {
      let size = quoteSize;
      if (tokenId.includes('down-') && tokenId.startsWith('eth-')) {
        size = ethDownSize;
      } else if (tokenId.includes('down-') && tokenId.startsWith('btc-')) {
        size = btcDownSize;
      } else if (tokenId.includes('up-') && tokenId.startsWith('eth-')) {
        size = ethUpSize;
      }
      return { asks: [{ price: String(askPrice), size: String(size) }], bids: [{ price: '0.20', size: '1000' }] };
    },
    getMarket,
  };
  const bot = new CrossPairBot({ marketData, now: () => now });
  return {
    bot,
    setNow(value) { now = value; },
    now: () => now,
    marketsById,
    marketFor,
    setAskPrice(value) { askPrice = value; },
  };
}

test('uses only the five configured combined-ask tiers and trades aligned 15-minute pairs', async () => {
  const { bot } = fixture();
  await bot.tick();
  const state = bot.snapshot();

  assert.equal(state.strategy.timeframe, '15m');
  assert.deepEqual(state.strategy.tiers.map(tier => tier.id), ['0.90', '0.80', '0.70', '0.60', '0.50']);
  assert.equal(state.window.end - state.window.start, 15 * 60 * 1000);
  assert.equal(state.account.startingCapital, 3000);
  assert.equal(state.trades.length, 20);
  assert.ok(state.trades.every(trade => trade.shares === 100));
  assert.ok(state.trades.every(trade => trade.entryPrice === 0.25));
  assert.equal(state.account.takerFees, 26.25);
  assert.equal(state.inventory.currentWindow.BTC.UP.shares, 500);
  assert.equal(state.inventory.currentWindow.ETH.DOWN.shares, 500);
  assert.equal(state.inventory.currentWindow.BTC.DOWN.shares, 500);
  assert.equal(state.inventory.currentWindow.ETH.UP.shares, 500);
  assert.ok(state.pairs.every(pair => pair.tiers.every(tier => tier.status === 'FILLED')));
});

test('does not book a partial leg as a paired fill', async () => {
  const { bot } = fixture({ quoteSize: 1000, btcDownSize: 50, ethUpSize: 50, ethDownSize: 50 });
  await bot.tick();
  const state = bot.snapshot();
  const firstPair = state.pairs.find(pair => pair.id === 'btc-up-eth-down');

  assert.equal(state.inventory.currentWindow.BTC.UP.shares, 0);
  assert.equal(state.inventory.currentWindow.ETH.DOWN.shares, 0);
  assert.equal(state.account.cash, 3000);
  assert.ok(firstPair.tiers.every(tier => tier.status === 'WAITING_FOR_FULL_DEPTH'));
});

test('refuses to trade when BTC and ETH market windows are not aligned', async () => {
  const { bot } = fixture({ misalignEth: true });
  await bot.tick();
  const state = bot.snapshot();

  assert.equal(state.trades.length, 0);
  assert.match(state.error, /same 15-minute window/);
});

test('moves expired positions to pending and settles only from confirmed original-market resolution', async () => {
  const { bot, setNow, now, marketsById, setAskPrice } = fixture();
  await bot.tick();
  const opened = bot.trades.slice();
  const oldWindowStart = bot.windowStart;
  const nextWindowStart = oldWindowStart + config.WINDOW_MS;

  for (const trade of opened) {
    const market = marketsById.get(trade.marketId);
    const upWon = trade.side === 'UP';
    marketsById.set(trade.marketId, {
      ...market,
      closed: true,
      umaResolutionStatus: 'resolved',
      outcomePrices: upWon ? ['1', '0'] : ['0', '1'],
    });
  }
  setNow(nextWindowStart + 1000);
  // The next window must not enter while this test checks settlement of the old market.
  setAskPrice(0.75);
  bot.lastResolutionCheckAt = now();
  await bot.tick();
  assert.equal(bot.trades.filter(trade => trade.status === 'AWAITING_RESOLUTION').length, 20);

  await bot.resolveDue(now(), { force: true });
  const state = bot.snapshot();
  assert.equal(state.account.pendingResolutionPositions, 0);
  assert.equal(state.account.settledPositions, 20);
  assert.ok(state.trades.every(trade => trade.finalOutcome === 'MARKET_RESOLUTION'));
  assert.equal(state.inventory.awaitingResolution.BTC.UP.shares, 0);
});
