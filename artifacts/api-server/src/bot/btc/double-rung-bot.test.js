const assert = require("node:assert/strict");
const test = require("node:test");
const { BtcDoubleRungBot } = require("./double-rung-bot.cjs");
const WINDOW_MS = 5 * 60 * 1000;

function fixture() {
  let currentTime = 960_000;
  const windowStart = 900_000;
  const market = {
    id: "market-current",
    slug: "btc-updown-5m-current",
    title: "BTC Up or Down",
    start: windowStart,
    end: windowStart + WINDOW_MS,
    tokens: { UP: "token-up", DOWN: "token-down" },
    raw: { feesEnabled: false },
  };
  const bot = new BtcDoubleRungBot({
    now: () => currentTime,
    marketData: {
      async getMarket() { return null; },
      async getBtcMarket(start) {
        return {
          ...market,
          id: start === windowStart ? "market-current" : `market-${start}`,
          start,
          end: start + WINDOW_MS,
        };
      },
      async getBook() { return { asks: [], bids: [] }; },
      connectMarketStream() { return { close() {} }; },
    },
  });
  bot.market = market;
  bot.windowStart = windowStart;
  bot.windowEnd = windowStart + WINDOW_MS;
  bot.storageHealthy = true;

  function setBook(side, { ask, bid, asks, bids, askSize = 1_000, bidSize = 1_000 }) {
    const tokenId = market.tokens[side];
    const normalizedAsks = asks || (ask == null ? [] : [{ price: ask, size: askSize }]);
    const normalizedBids = bids || (bid == null ? [] : [{ price: bid, size: bidSize }]);
    const book = {
      asks: normalizedAsks.map(level => ({
        price: level.price,
        size: level.size,
        availableSize: level.size,
      })).sort((a, b) => a.price - b.price),
      bids: normalizedBids.map(level => ({
        price: level.price,
        size: level.size,
        availableSize: level.size,
      })).sort((a, b) => b.price - a.price),
      updatedAt: currentTime,
      sourceTimestamp: currentTime,
    };
    bot.books.set(tokenId, book);
    bot.updateQuoteFromBook(side, tokenId, book, currentTime);
  }

  return {
    bot,
    market,
    setBook,
    setNow(value) { currentTime = value; },
    getNow() { return currentTime; },
  };
}

function seedBoth(context, upAsk = 0.25, downAsk = 0.55) {
  context.setBook("UP", { ask: upAsk, bid: Math.max(0.01, upAsk - 0.01) });
  context.setBook("DOWN", { ask: downAsk, bid: Math.max(0.01, downAsk - 0.01) });
  assert.equal(context.bot.evaluate(context.getNow()), true);
}

test("the window seed independently market-buys 5 shares on both sides", () => {
  const context = fixture();
  seedBoth(context, 0.25, 0.45);

  assert.equal(context.bot.trades.length, 2);
  assert.deepEqual(context.bot.trades.map(trade => [trade.side, trade.shares]), [
    ["UP", 5],
    ["DOWN", 5],
  ]);
  assert.equal(context.bot.sideStates.UP.baseEntryDone, true);
  assert.equal(context.bot.sideStates.DOWN.baseEntryDone, true);
  assert.equal(context.bot.snapshot().strategy.entryOrderType, "MARKET BUY (PAPER)");
});

test("crossed rungs trigger once per side and double successive requested size", () => {
  const context = fixture();
  seedBoth(context, 0.25, 0.75);

  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.45, bid: 0.44 });
  context.setBook("DOWN", { ask: 0.55, bid: 0.54 });
  assert.equal(context.bot.evaluate(context.getNow()), true);

  const upRungs = context.bot.trades.filter(trade =>
    trade.side === "UP" && trade.entryReason === "RUNG_CROSS");
  const downRungs = context.bot.trades.filter(trade =>
    trade.side === "DOWN" && trade.entryReason === "RUNG_CROSS");
  assert.deepEqual(upRungs.map(trade => trade.requestedShares), [10, 20]);
  assert.deepEqual(downRungs.map(trade => trade.requestedShares), [10, 20]);
  assert.equal(context.bot.sideStates.UP.nextOrderShares, 40);
  assert.equal(context.bot.sideStates.DOWN.nextOrderShares, 40);
  assert.equal(context.bot.sideStates.UP.rungs.find(rung => rung.price === 0.30).status, "FILLED");
  assert.equal(context.bot.sideStates.DOWN.rungs.find(rung => rung.price === 0.70).status, "FILLED");

  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.30, bid: 0.29 });
  context.setBook("DOWN", { ask: 0.70, bid: 0.69 });
  context.bot.evaluate(context.getNow());
  assert.equal(context.bot.trades.filter(trade => trade.entryReason === "RUNG_CROSS").length, 4);
});

test("a seed at an exact rung price does not trigger that level again", () => {
  const context = fixture();
  seedBoth(context, 0.40, 0.60);

  assert.equal(context.bot.sideStates.UP.rungs.find(rung => rung.price === 0.40).status, "USED_BY_SEED");
  assert.equal(context.bot.sideStates.DOWN.rungs.find(rung => rung.price === 0.60).status, "USED_BY_SEED");

  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.41, bid: 0.40 });
  context.setBook("DOWN", { ask: 0.59, bid: 0.58 });
  context.bot.evaluate(context.getNow());
  assert.equal(context.bot.trades.filter(trade =>
    trade.entryReason === "RUNG_CROSS" && trade.rungPrice === 0.40).length, 0);
  assert.equal(context.bot.trades.filter(trade =>
    trade.entryReason === "RUNG_CROSS" && trade.rungPrice === 0.60).length, 0);
});

test("market entries record actual partial depth and taker fees", () => {
  const context = fixture();
  context.market.raw.feesEnabled = true;
  context.setBook("UP", {
    asks: [{ price: 0.25, size: 2 }, { price: 0.26, size: 1 }],
    bids: [{ price: 0.24, size: 100 }],
  });
  context.setBook("DOWN", { ask: 0.45, bid: 0.44 });
  context.bot.evaluate(context.getNow());

  const upTrade = context.bot.trades.find(trade => trade.side === "UP");
  assert.equal(upTrade.requestedShares, 5);
  assert.equal(upTrade.shares, 3);
  assert.ok(upTrade.fees > 0);
  assert.equal(context.bot.sideStates.UP.baseEntryDone, true);
  assert.equal(context.bot.sideStates.UP.baseFilledShares, 3);
});

test("stale quotes hide floating P&L but retain the last marked value in equity", () => {
  const context = fixture();
  seedBoth(context, 0.25, 0.45);
  context.bot.updateOpenMarks(context.getNow());
  const priorEquity = context.bot.accountSnapshot().equity;
  const priorMark = context.bot.trades[0].markValue;

  context.setNow(context.getNow() + 3_000);
  context.bot.updateOpenMarks(context.getNow());

  assert.equal(context.bot.trades[0].markFresh, false);
  assert.equal(context.bot.trades[0].markValue, priorMark);
  assert.equal(context.bot.sidePositionSnapshot("UP", context.getNow()).unrealizedPnl, null);
  assert.equal(context.bot.accountSnapshot().equity, priorEquity);
});

test("the $0.99 bid closes every open trade on that side and stops only that side", () => {
  const context = fixture();
  seedBoth(context, 0.25, 0.45);
  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.35, bid: 0.34 });
  context.setBook("DOWN", { ask: 0.45, bid: 0.44 });
  context.bot.evaluate(context.getNow());

  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.99, bid: 0.99 });
  context.setBook("DOWN", { ask: 0.46, bid: 0.45 });
  context.bot.evaluate(context.getNow());

  assert.ok(context.bot.trades.filter(trade => trade.side === "UP")
    .every(trade => trade.status === "SETTLED" && trade.exitPrice === 1));
  assert.ok(context.bot.trades.filter(trade => trade.side === "DOWN")
    .every(trade => trade.status === "OPEN"));
  assert.equal(context.bot.sideStates.UP.stopped, true);
  assert.equal(context.bot.sideStates.DOWN.stopped, false);
  assert.equal(context.bot.accountSnapshot().takerFees, 0);
});

test("there is no stop-loss and unresolved positions wait for the original market", async () => {
  const context = fixture();
  seedBoth(context);
  context.setNow(context.getNow() + 1_000);
  context.setBook("UP", { ask: 0.10, bid: 0.01 });
  context.setBook("DOWN", { ask: 0.55, bid: 0.54 });
  context.bot.evaluate(context.getNow());
  assert.ok(context.bot.trades.some(trade => trade.side === "UP" && trade.status === "OPEN"));

  const oldMarketId = context.bot.trades[0].marketId;
  await context.bot.resetWindow(context.bot.windowEnd);
  assert.ok(context.bot.trades.filter(trade => trade.marketId === oldMarketId)
    .every(trade => trade.status === "AWAITING_RESOLUTION"));
  assert.equal(context.bot.sideStates.UP.baseEntryDone, false);
});

test("positions from a replaced strategy stay linked to their original resolution", () => {
  const context = fixture();
  context.bot.restoreState({
    strategyVersion: "previous-btc-strategy",
    startingCapital: 3_000,
    cash: 2_900,
    realizedPnl: 0,
    trades: [{
      id: "legacy-open",
      status: "OPEN",
      side: "UP",
      marketId: "old-market-id",
      windowStart: 600_000,
      shares: 100,
      totalCost: 100,
    }],
    events: [],
    windowStart: 600_000,
    sideStates: null,
  });

  assert.equal(context.bot.windowStart, null);
  assert.equal(context.bot.trades[0].status, "AWAITING_RESOLUTION");
  assert.equal(context.bot.trades[0].marketId, "old-market-id");
  assert.equal(context.bot.snapshot().events[0].type, "STRATEGY_STATE_MIGRATED");
});
