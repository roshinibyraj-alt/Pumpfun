const assert = require("node:assert/strict");
const test = require("node:test");
const { Btc5mAskAbsorptionBot } = require("./btc-5m-ask-absorption-bot.cjs");

const WINDOW_MS = 5 * 60 * 1000;
const START = 1_800_000_000_000;

function fixture() {
  let now = START + 1_000;
  const market = {
    id: "market-5m-current",
    slug: "btc-updown-5m-current",
    title: "Bitcoin Up or Down",
    start: START,
    end: START + WINDOW_MS,
    tokens: { UP: "token-up", DOWN: "token-down" },
    raw: { feesEnabled: false },
  };
  const bot = new Btc5mAskAbsorptionBot({
    now: () => now,
    marketData: {
      async getMarket() { return null; },
      async getBtcMarket(start) {
        return {
          ...market,
          id: start === START ? market.id : `market-${start}`,
          start,
          end: start + WINDOW_MS,
        };
      },
      async getBook() { return { asks: [], bids: [] }; },
      connectMarketStream() { return { close() {} }; },
    },
  });
  bot.market = market;
  bot.windowStart = START;
  bot.windowEnd = START + WINDOW_MS;
  bot.storageHealthy = true;

  function setNow(value) {
    now = value;
  }

  function setBook(side, { asks, bids } = {}) {
    const tokenId = market.tokens[side];
    const book = {
      asks: (asks || [{ price: 0.50, size: 100 }])
        .map(level => ({ ...level, availableSize: level.size }))
        .sort((left, right) => left.price - right.price),
      bids: (bids || [{ price: 0.49, size: 100 }])
        .map(level => ({ ...level, availableSize: level.size }))
        .sort((left, right) => right.price - left.price),
      updatedAt: now,
      sourceTimestamp: now,
    };
    bot.books.set(tokenId, book);
    bot.updateQuoteFromBook(side, tokenId, book, now);
  }

  function seedBooks() {
    setBook("UP");
    setBook("DOWN");
    bot.evaluate(now);
  }

  function trade(side, { price = 0.50, shares = 20, orderSide = "BUY" } = {}) {
    const at = now;
    bot.handleMarketMessage({
      event_type: "last_trade_price",
      asset_id: market.tokens[side],
      price: String(price),
      size: String(shares),
      side: orderSide,
      timestamp: String(at),
    });
  }

  return { bot, market, now: () => now, setNow, setBook, seedBooks, trade };
}

test("uses five-minute windows and makes no entry before the first 10-second check", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_999);
  context.setBook("UP");
  context.setBook("DOWN");
  context.trade("UP");
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades.length, 0);
  assert.equal(context.bot.snapshot().strategy.timeframe, "5m");
  assert.equal(context.bot.snapshot().strategy.sharesPerCheck, 10);
});

test("buys 10 shares on the side with verified ask absorption and price confirmation", () => {
  const context = fixture();
  context.seedBooks();

  context.setNow(START + 9_500);
  context.trade("UP", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.setBook("DOWN", { asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] });
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades.length, 1);
  assert.equal(context.bot.trades[0].side, "UP");
  assert.equal(context.bot.trades[0].requestedShares, 10);
  assert.equal(context.bot.trades[0].shares, 10);
  assert.equal(context.bot.trades[0].entryOrderType, "MARKET");
  assert.equal(context.bot.trades[0].entryReason, "ASK_ABSORPTION_10S");
  assert.equal(context.bot.snapshot().absorption.lastDecision.status, "BUY_FILLED");
});

test("book-depth disappearance without buy-side trade prints is not treated as absorption", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 10_000);
  context.setBook("UP", { asks: [{ price: 0.51, size: 50 }], bids: [{ price: 0.50, size: 100 }] });
  context.setBook("DOWN");
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades.length, 0);
  assert.equal(context.bot.snapshot().absorption.lastDecision.status, "NO_SIGNAL");
});

test("similar qualifying absorption on both sides does not trigger an arbitrary side", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_500);
  context.trade("UP", { shares: 20 });
  context.trade("DOWN", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.setBook("DOWN", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades.length, 0);
  assert.match(context.bot.snapshot().absorption.lastDecision.reason, /similar absorption/i);
});

test("a later independent 10-second check can add another 10 shares", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_500);
  context.trade("UP", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.setBook("DOWN");
  context.bot.evaluate(context.now());
  assert.equal(context.bot.trades.length, 1);

  context.setNow(START + 19_500);
  context.trade("UP", { price: 0.51, shares: 20 });
  context.setNow(START + 20_000);
  context.setBook("UP", { asks: [{ price: 0.52, size: 80 }], bids: [{ price: 0.51, size: 100 }] });
  context.setBook("DOWN");
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades.length, 2);
  assert.deepEqual(context.bot.trades.map(trade => trade.requestedShares), [10, 10]);
});

test("a $0.99 bid closes all same-side shares for $1 and allows a later re-entry", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_500);
  context.trade("UP", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.setBook("DOWN");
  context.bot.evaluate(context.now());
  const cost = context.bot.trades[0].totalCost;

  context.setNow(START + 10_500);
  context.setBook("UP", { asks: [{ price: 0.99, size: 100 }], bids: [{ price: 0.99, size: 100 }] });
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades[0].status, "SETTLED");
  assert.equal(context.bot.trades[0].exitPrice, 1);
  assert.equal(context.bot.trades[0].realizedPnl, 10 - cost);
  assert.equal(context.bot.sideStates.UP.stopped, false);
});

test("a fresh empty bid closes open same-side shares at $0", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_500);
  context.trade("DOWN", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP");
  context.setBook("DOWN", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.bot.evaluate(context.now());
  const cost = context.bot.trades[0].totalCost;

  context.setNow(START + 10_500);
  context.setBook("DOWN", { asks: [{ price: 0.50, size: 100 }], bids: [] });
  context.bot.evaluate(context.now());

  assert.equal(context.bot.trades[0].status, "SETTLED");
  assert.equal(context.bot.trades[0].exitPrice, 0);
  assert.equal(context.bot.trades[0].realizedPnl, -cost);
  assert.equal(context.bot.trades[0].settlementSource, "INTRAWINDOW_STOP_LOSS");
});

test("a zero best-bid quote alone does not override a still-populated fresh book", () => {
  const context = fixture();
  context.seedBooks();
  context.setNow(START + 9_500);
  context.trade("DOWN", { shares: 20 });
  context.setNow(START + 10_000);
  context.setBook("UP");
  context.setBook("DOWN", { asks: [{ price: 0.51, size: 80 }], bids: [{ price: 0.50, size: 100 }] });
  context.bot.evaluate(context.now());
  assert.equal(context.bot.trades.length, 1);

  context.setNow(START + 10_500);
  context.bot.handleMarketMessage({
    event_type: "best_bid_ask",
    asset_id: "token-down",
    best_bid: "",
    best_ask: "0.51",
    timestamp: String(context.now()),
  });

  assert.equal(context.bot.trades[0].status, "OPEN");
});

test("replacing strategy migrates existing open positions without erasing history", () => {
  const context = fixture();
  context.bot.restoreState({
    strategyVersion: "old-15m-ladder",
    startingCapital: 3_000,
    cash: 2_900,
    realizedPnl: -100,
    trades: [{
      id: "old-open-position",
      status: "OPEN",
      side: "UP",
      marketId: "old-15m-market",
      windowStart: START - 900_000,
      windowEnd: START - 1,
      shares: 100,
      totalCost: 100,
    }],
    events: [],
    windowStart: START - 900_000,
  });

  assert.equal(context.bot.trades[0].status, "AWAITING_RESOLUTION");
  assert.equal(context.bot.trades[0].marketId, "old-15m-market");
  assert.equal(context.bot.cash, 2_900);
  assert.equal(context.bot.realizedPnl, -100);
});

test("the new strategy ignores any leftover environment history-reset request", () => {
  const { bot } = fixture();
  assert.equal(bot.shouldApplyEnvironmentHistoryReset(), false);
});
