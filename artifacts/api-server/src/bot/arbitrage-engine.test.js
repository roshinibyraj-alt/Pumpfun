"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./arbitrage-engine.js");
const ArbitrageBot = require("./arbitrage-bot.js");

function goodBook(asks, observedAt = 1000) {
  return { status: "ok", observedAt, asks, bids: [] };
}

function pairLeg(venue, side, model, asks, marketMatched = true, observedAt = 1000) {
  return {
    venue,
    side,
    feeModel: model,
    marketMatched,
    book: goodBook(asks, observedAt),
  };
}

test("uses the documented depth-level taker fee formulas", () => {
  assert.ok(Math.abs(engine.polymarketTakerFee(100, 0.5) - 1.75) < 1e-12);
  assert.equal(engine.predictTakerFee(100, 0.5), 1);
  assert.ok(Math.abs(engine.polymarketTakerFee(10, 0.2) - 0.112) < 1e-12);
  assert.ok(Math.abs(engine.predictTakerFee(10, 0.2) - 0.04) < 1e-12);
});

test("converts Predict's YES-only book into the complementary NO book at tick precision", () => {
  const book = engine.complementYesBook(
    {
      asks: [
        [0.4, 10],
        [0.45, 20],
      ],
      bids: [
        [0.35, 5],
        [0.3, 7],
      ],
    },
    2,
  );
  assert.deepEqual(book.no.asks, [
    { price: 0.65, size: 5 },
    { price: 0.7, size: 7 },
  ]);
  assert.deepEqual(book.no.bids, [
    { price: 0.6, size: 10 },
    { price: 0.55, size: 20 },
  ]);
});

test("matches only exact five-minute UTC boundaries", () => {
  const first = engine.windowForTime(Date.UTC(2026, 9, 6, 13, 47, 12));
  assert.deepEqual(first, {
    openMs: Date.UTC(2026, 9, 6, 13, 45, 0),
    closeMs: Date.UTC(2026, 9, 6, 13, 50, 0),
  });
  assert.equal(engine.windowsMatch(first, { ...first }), true);
  assert.equal(
    engine.windowsMatch(first, { openMs: first.openMs, closeMs: first.closeMs + 300000 }),
    false,
  );
});

test("maps Predict UP/DOWN only when the actual binary outcomes are explicit and safe", () => {
  const market = {
    variantData: { type: "CRYPTO_UP_DOWN" },
    outcomes: [
      { name: "Up", indexSet: 1 },
      { name: "Down", indexSet: 2 },
    ],
  };
  assert.equal(engine.mapPredictUpDownOutcomes(market).safe, true);
  assert.equal(
    engine.mapPredictUpDownOutcomes({
      ...market,
      outcomes: [...market.outcomes, { name: "Flat", indexSet: 4 }],
    }).safe,
    false,
  );
  assert.equal(
    engine.mapPredictUpDownOutcomes({
      ...market,
      outcomes: [
        { name: "Yes", indexSet: 1 },
        { name: "No", indexSet: 2 },
      ],
    }).safe,
    false,
  );
});

test("matches a Predict market through explicit 5m boundaries or its exact Polymarket condition link", () => {
  const expected = {
    openMs: Date.UTC(2026, 9, 6, 13, 45),
    closeMs: Date.UTC(2026, 9, 6, 13, 50),
  };
  const market = {
    id: 12,
    tradingStatus: "OPEN",
    variantData: {
      type: "CRYPTO_UP_DOWN",
      startTime: new Date(expected.openMs).toISOString(),
      endTime: new Date(expected.closeMs).toISOString(),
    },
    outcomes: [
      { name: "Up", indexSet: 1 },
      { name: "Down", indexSet: 2 },
    ],
  };
  assert.equal(
    engine.evaluatePredictMarketMatch(market, expected, "0xcondition").matched,
    true,
  );
  const linked = {
    ...market,
    variantData: { type: "CRYPTO_UP_DOWN" },
    polymarketConditionIds: ["0xcondition"],
  };
  assert.equal(
    engine.evaluatePredictMarketMatch(linked, expected, "0xcondition").matchMethod,
    "polymarket_condition_id",
  );
  assert.equal(
    engine.evaluatePredictMarketMatch(
      { ...linked, polymarketConditionIds: [] },
      expected,
      "0xcondition",
    ).matched,
    false,
  );
});

test("derives an exact aligned five-minute window from Predict's canonical slug", () => {
  const openMs = Date.UTC(2026, 9, 6, 13, 45);
  const market = { slug: `btc-updown-5m-${openMs / 1000}` };
  assert.deepEqual(engine.getExplicitMarketWindow(market), {
    openMs,
    closeMs: openMs + 5 * 60 * 1000,
  });
  assert.equal(
    engine.evaluatePredictMarketMatch(
      {
        ...market,
        status: "OPEN",
        variantData: { type: "CRYPTO_UP_DOWN" },
        outcomes: [
          { name: "Up", indexSet: 1 },
          { name: "Down", indexSet: 2 },
        ],
      },
      { openMs, closeMs: openMs + 5 * 60 * 1000 },
      null,
    ).matchMethod,
    "slug_window",
  );
  assert.equal(
    engine.getExplicitMarketWindow({ slug: "btc-updown-5m-1791299701" }),
    null,
  );
  assert.equal(
    engine.getExplicitMarketWindow({ slug: "btc-updown-15m-1791299700" }),
    null,
  );
});

test("sizes both legs to identical shares without exceeding $100 cash per leg", () => {
  const result = engine.evaluatePair({
    nowMs: 1000,
    maxCashPerLegUsd: 100,
    minNetEdgePerShare: 0.1,
    safetyMarginPerShare: 0.01,
    legs: [
      pairLeg("Polymarket", "UP", "polymarket", [{ price: 0.4, size: 1000 }]),
      pairLeg("Predict.fun", "DOWN", "predict", [{ price: 0.4, size: 1000 }]),
    ],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.legs[0].shares, result.legs[1].shares);
  assert.ok(result.legs.every((leg) => leg.cash <= 100 + 1e-6));
  assert.ok(result.netEdgePerShare >= 0.1);
  assert.ok(result.legs.every((leg) => leg.shares === result.shares));
});

test("rejects a stale leg instead of creating a paper pair", () => {
  const result = engine.evaluatePair({
    nowMs: 20_000,
    maxBookAgeMs: 5000,
    legs: [
      pairLeg("Polymarket", "UP", "polymarket", [{ price: 0.4, size: 100 }], true, 19_000),
      pairLeg("Predict.fun", "DOWN", "predict", [{ price: 0.4, size: 100 }], true, 10_000),
    ],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /stale/i);
});

test("requires at least $0.10 net edge per share after fees and safety margin", () => {
  const result = engine.evaluatePair({
    nowMs: 1000,
    maxCashPerLegUsd: 100,
    minNetEdgePerShare: 0.1,
    safetyMarginPerShare: 0.01,
    legs: [
      pairLeg("Polymarket", "UP", "polymarket", [{ price: 0.45, size: 1000 }]),
      pairLeg("Predict.fun", "DOWN", "predict", [{ price: 0.45, size: 1000 }]),
    ],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, "below_threshold");
});

test("tracks starting demo capital, open commitment, available cash, and provisional equity", () => {
  const result = engine.calculatePaperCapital({
    startingCapitalUsd: 10_000,
    realizedPnlUsd: 125.5,
    trades: [
      { finalized: false, pairCash: 240, provisionalPnl: -35 },
      { finalized: true, pairCash: 180, realizedPnl: 125.5 },
    ],
  });
  assert.equal(result.startingCapitalUsd, 10_000);
  assert.equal(result.cashBalanceUsd, 10_125.5);
  assert.equal(result.capitalCommittedUsd, 240);
  assert.equal(result.availableCapitalUsd, 9_885.5);
  assert.equal(result.provisionalPnlUsd, -35);
  assert.equal(result.paperEquityUsd, 10_090.5);
});

test("does not allow an opportunity when no demo capital remains", () => {
  const result = engine.evaluatePair({
    nowMs: 1000,
    maxCashPerLegUsd: 0,
    legs: [
      pairLeg("Polymarket", "UP", "polymarket", [{ price: 0.4, size: 1000 }]),
      pairLeg("Predict.fun", "DOWN", "predict", [{ price: 0.4, size: 1000 }]),
    ],
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /no available demo capital/i);
});

test("shows Predict quotes for an unmatched market without marking it pair-eligible", async () => {
  const nowMs = Date.now();
  const market = {
    id: 12,
    title: "Bitcoin Up or Down on the prior day?",
    tradingStatus: "OPEN",
    conditionId: "predict-condition",
    variantData: { type: "CRYPTO_UP_DOWN" },
    outcomes: [
      { name: "Up", indexSet: 1 },
      { name: "Down", indexSet: 2 },
    ],
    decimalPrecision: 2,
  };
  const bot = new ArbitrageBot({
    predictApiKey: "test-only-placeholder",
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            bids: [[0.45, 20]],
            asks: [[0.5, 30]],
            updateTimestampMs: nowMs,
          },
        }),
    }),
  });
  const window = { openMs: nowMs - 60_000, closeMs: nowMs + 240_000 };
  bot.predictCache = {
    fetchedAt: nowMs,
    windowSlug: `btc-updown-5m-${Math.floor(window.openMs / 1000)}`,
    markets: [market],
    error: null,
  };
  const venue = await bot._fetchPredict(window, "polymarket-condition", nowMs);

  assert.equal(venue.status, "unmatched");
  assert.equal(venue.market.matchStatus, "unmatched");
  assert.equal(venue.marketCandidates.length, 1);
  assert.equal(venue.up.bestAsk.price, 0.5);
  assert.equal(venue.down.bestAsk.price, 0.55);
  assert.match(venue.market.matchReason, /not matched/i);
});

test("discovers the exact Predict five-minute market through targeted search and loads its book", async () => {
  const nowMs = Date.now();
  const openMs = Math.floor(nowMs / (5 * 60 * 1000)) * 5 * 60 * 1000;
  const window = { openMs, closeMs: openMs + 5 * 60 * 1000 };
  const slug = `btc-updown-5m-${openMs / 1000}`;
  const market = {
    id: 2966820,
    slug,
    title: "Bitcoin Up or Down - current five-minute window",
    status: "OPEN",
    conditionId: "predict-current-window",
    variantData: { type: "CRYPTO_UP_DOWN" },
    outcomes: [
      { name: "Up", indexSet: 1 },
      { name: "Down", indexSet: 2 },
    ],
    decimalPrecision: 2,
  };
  const requests = [];
  const bot = new ArbitrageBot({
    predictApiKey: "test-only-placeholder",
    fetch: async (url, options) => {
      requests.push({ url: String(url), headers: options?.headers });
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/markets") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [], cursor: null }),
        };
      }
      if (parsed.pathname === "/v1/search") {
        assert.equal(parsed.searchParams.get("query"), slug);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              data: { categories: [{ id: "btc", markets: [market] }] },
            }),
        };
      }
      assert.equal(parsed.pathname, `/v1/markets/${market.id}/orderbook`);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              bids: [[0.48, 20]],
              asks: [[0.5, 30]],
              updateTimestampMs: nowMs,
            },
          }),
      };
    },
  });

  const venue = await bot._fetchPredict(window, null, nowMs);

  assert.equal(venue.status, "connected");
  assert.equal(venue.market.matchStatus, "matched");
  assert.equal(venue.market.matchMethod, "slug_window");
  assert.equal(venue.market.id, String(market.id));
  assert.equal(venue.market.startMs, window.openMs);
  assert.equal(venue.market.closeMs, window.closeMs);
  assert.equal(venue.up.bestAsk.price, 0.5);
  assert.equal(venue.down.bestAsk.price, 0.52);
  assert.ok(
    requests.every(
      (request) => request.headers["x-api-key"] === "test-only-placeholder",
    ),
  );
  assert.equal(
    requests.filter((request) => new URL(request.url).pathname === "/v1/search")
      .length,
    1,
  );
});

test("resolves a missed Predict slot through its exact public page and documented market-details endpoint", async () => {
  const nowMs = Date.now();
  const openMs = Math.floor(nowMs / (5 * 60 * 1000)) * 5 * 60 * 1000;
  const window = { openMs, closeMs: openMs + 5 * 60 * 1000 };
  const slug = `btc-updown-5m-${openMs / 1000}`;
  const marketId = "2967672";
  const market = {
    id: Number(marketId),
    title: "Bitcoin Up or Down - current five-minute window",
    status: "OPEN",
    conditionId: "predict-current-window",
    variantData: { type: "CRYPTO_UP_DOWN" },
    outcomes: [
      { name: "Up", indexSet: 1 },
      { name: "Down", indexSet: 2 },
    ],
    decimalPrecision: 2,
  };
  const requests = [];
  const bot = new ArbitrageBot({
    predictApiKey: "test-only-placeholder",
    fetch: async (url, options) => {
      const parsed = new URL(String(url));
      requests.push({
        url: String(url),
        headers: options?.headers,
      });
      if (parsed.pathname === "/v1/search") {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ success: true, data: { categories: [] } }),
        };
      }
      if (parsed.pathname === "/v1/markets") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [], cursor: null }),
        };
      }
      if (parsed.hostname === "predict.fun" && parsed.pathname === `/market/${slug}`) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<meta property="og:image" content="https://predict.fun/api/generate/image/market.png?marketId=${marketId}&amp;categoryId=${slug}&amp;v=2">`,
        };
      }
      if (parsed.pathname === `/v1/markets/${marketId}`) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true, data: market }),
        };
      }
      assert.equal(parsed.pathname, `/v1/markets/${marketId}/orderbook`);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              bids: [[0.29, 20]],
              asks: [[0.31, 30]],
              updateTimestampMs: nowMs,
            },
          }),
      };
    },
  });

  const venue = await bot._fetchPredict(window, null, nowMs);

  assert.equal(venue.status, "connected");
  assert.equal(venue.market.matchStatus, "matched");
  assert.equal(venue.market.matchMethod, "slug_window");
  assert.equal(venue.market.slug, slug);
  assert.equal(venue.market.id, marketId);
  assert.equal(venue.up.bestBid.price, 0.29);
  assert.equal(venue.up.bestAsk.price, 0.31);
  const pageRequest = requests.find((request) =>
    request.url.startsWith("https://predict.fun/market/"),
  );
  assert.ok(pageRequest);
  assert.equal(pageRequest.headers["x-api-key"], undefined);
  const detailRequest = requests.find((request) =>
    request.url.endsWith(`/v1/markets/${marketId}`),
  );
  assert.equal(detailRequest.headers["x-api-key"], "test-only-placeholder");
});

test("keeps paper P&L provisional while open and finalizes only after the shared window closes", () => {
  const trade = {
    openMs: 0,
    closeMs: 300_000,
    pairCash: 8,
    legs: [
      { side: "UP", shares: 10 },
      { side: "DOWN", shares: 10 },
    ],
  };
  const openBenchmark = {
    openMs: 0,
    closeMs: 300_000,
    openPrice: 100,
    currentPrice: 99,
    finalized: false,
  };
  const beforeClose = engine.updateTradeWithBenchmark(trade, openBenchmark, 299_999);
  assert.equal(beforeClose.finalized, false);
  assert.equal(beforeClose.status, "open_provisional");
  assert.equal(beforeClose.provisionalOutcome, "DOWN");
  assert.equal(beforeClose.provisionalPnl, 2);

  const notYetFinal = engine.updateTradeWithBenchmark(
    trade,
    { ...openBenchmark, currentPrice: 98, finalClosePrice: 98, finalized: false },
    300_000,
  );
  assert.equal(notYetFinal.finalized, false);
  assert.equal(notYetFinal.status, "awaiting_final_benchmark");

  const final = engine.updateTradeWithBenchmark(
    trade,
    {
      ...openBenchmark,
      currentPrice: 98,
      finalClosePrice: 98,
      finalized: true,
      finalizedAt: 300_500,
    },
    300_500,
  );
  assert.equal(final.finalized, true);
  assert.equal(final.status, "finalized_internal_benchmark");
  assert.equal(final.finalOutcome, "DOWN");
  assert.equal(final.finalPayout, 10);
  assert.equal(final.realizedPnl, 2);
  assert.equal(final.settlementLabel, "INTERNAL_BENCHMARK_NOT_OFFICIAL_SETTLEMENT");
});
