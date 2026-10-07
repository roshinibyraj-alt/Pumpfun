"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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

test("reads Polymarket settlement only from a closed binary market with definitive 1/0 prices", () => {
  const resolved = {
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: '["Up","Down"]',
    outcomePrices: '["1","0"]',
  };
  assert.equal(engine.getPolymarketResolvedOutcome(resolved), "UP");
  assert.equal(
    engine.getPolymarketResolvedOutcome({
      ...resolved,
      closed: false,
    }),
    null,
  );
  assert.equal(
    engine.getPolymarketResolvedOutcome({
      ...resolved,
      outcomePrices: '["0.75","0.25"]',
    }),
    null,
  );
  assert.equal(
    engine.getPolymarketResolvedOutcome({
      ...resolved,
      outcomes: '["Yes","No"]',
    }),
    null,
  );
});

test("reads Predict settlement only from its exact resolved binary UP/DOWN result", () => {
  const resolved = {
    marketVariant: "CRYPTO_UP_DOWN",
    status: "RESOLVED",
    outcomes: {
      edges: [
        { node: { name: "Up", index: 1, status: "LOST" } },
        { node: { name: "Down", index: 2, status: "WON" } },
      ],
    },
    resolution: { name: "Down", index: 2, status: "WON" },
  };
  assert.equal(engine.getPredictResolvedOutcome(resolved), "DOWN");
  assert.equal(
    engine.getPredictResolvedOutcome({
      ...resolved,
      resolution: { name: "Up", index: 1, status: "WON" },
    }),
    null,
  );
  assert.equal(
    engine.getPredictResolvedOutcome({
      ...resolved,
      outcomes: [
        { name: "Up", indexSet: 1, status: "WON" },
        { name: "Down", indexSet: 2, status: "LOST" },
        { name: "Flat", indexSet: 4, status: "LOST" },
      ],
    }),
    null,
  );
  assert.equal(
    engine.getPredictResolvedOutcome({ ...resolved, status: "CLOSED" }),
    null,
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

test("blocks opportunities when cross-venue book snapshots are too far apart", () => {
  const result = engine.evaluatePair({
    nowMs: 20_000,
    maxBookAgeMs: 5000,
    maxBookSkewMs: 1000,
    legs: [
      pairLeg("Polymarket", "UP", "polymarket", [{ price: 0.4, size: 100 }], true, 19_500),
      pairLeg("Predict.fun", "DOWN", "predict", [{ price: 0.4, size: 100 }], true, 18_000),
    ],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /snapshots are 1500 ms apart/i);
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

test("waits for modeled order arrival and misses a signal that disappears in newer books", () => {
  const bot = new ArbitrageBot({ paperBaseLatencyMs: 500 });
  const window = { openMs: 1_000_000, closeMs: 1_300_000 };
  const signal = {
    direction: "POLY_UP + PREDICT_DOWN",
    status: "trigger",
    eligible: true,
    shares: 10,
    pairCash: 7.5,
    pairCostPerShare: 0.75,
    netEdgePerShare: 0.15,
    legs: [
      { venue: "Polymarket", side: "UP", requestLatencyMs: 100 },
      { venue: "Predict.fun", side: "DOWN", requestLatencyMs: 200 },
    ],
  };
  const detectedAt = 1_000_000;
  bot._schedulePaperPairs(window, [signal], detectedAt);
  const pending = bot.pendingPaperPairs.get(`${window.openMs}:${signal.direction}`);
  const arrivedAt = pending.simulatedArrivalAt;

  bot._processPendingPaperPairs(
    window,
    [signal],
    null,
    arrivedAt - 1,
  );
  assert.equal(bot.state.paperTrades.length, 0);
  assert.equal(bot.pendingPaperPairs.size, 1);

  const movedBookOpportunity = {
    ...signal,
    status: "below_threshold",
    eligible: false,
    pairCostPerShare: 0.95,
    netEdgePerShare: -0.05,
    reason: "Price moved and the net edge is below threshold.",
    legs: signal.legs.map((leg) => ({
      ...leg,
      quoteReceivedAt: arrivedAt + 100,
    })),
  };
  bot._processPendingPaperPairs(
    window,
    [movedBookOpportunity],
    null,
    arrivedAt + 100,
  );
  assert.equal(bot.state.paperTrades.length, 0);
  assert.equal(bot.pendingPaperPairs.size, 0);
  assert.ok(bot.state.events.some((event) => event.event === "PAPER_PAIR_MISSED"));
});

test("records delayed paper fills using arrival prices and stores cost drift", () => {
  const bot = new ArbitrageBot({ paperBaseLatencyMs: 500 });
  const window = { openMs: 2_000_000, closeMs: 2_300_000 };
  const signal = {
    direction: "POLY_UP + PREDICT_DOWN",
    status: "trigger",
    eligible: true,
    shares: 10,
    pairCash: 7.5,
    pairCostPerShare: 0.75,
    netEdgePerShare: 0.15,
    grossEdgePerShare: 0.16,
    safetyMarginPerShare: 0.01,
    fees: 0.1,
    legs: [
      {
        venue: "Polymarket",
        side: "UP",
        feeModel: "polymarket",
        shares: 10,
        requestLatencyMs: 100,
        averagePrice: 0.38,
        bestAsk: 0.37,
        worstFillPrice: 0.39,
        notional: 3.8,
        fees: 0.05,
        cash: 3.85,
        depthSlippagePerShare: 0.01,
        levelsUsed: 2,
        fills: [],
      },
      {
        venue: "Predict.fun",
        side: "DOWN",
        feeModel: "predict",
        shares: 10,
        requestLatencyMs: 200,
        averagePrice: 0.39,
        bestAsk: 0.38,
        worstFillPrice: 0.4,
        notional: 3.9,
        fees: 0.05,
        cash: 3.95,
        depthSlippagePerShare: 0.01,
        levelsUsed: 2,
        fills: [],
      },
    ],
  };
  const detectedAt = 2_000_000;
  bot._schedulePaperPairs(window, [signal], detectedAt);
  const pending = bot.pendingPaperPairs.get(`${window.openMs}:${signal.direction}`);
  const executionAt = pending.simulatedArrivalAt + 100;
  const arrivalOpportunity = {
    ...signal,
    pairCash: 7.8,
    pairCostPerShare: 0.78,
    netEdgePerShare: 0.12,
    legs: signal.legs.map((leg) => ({
      ...leg,
      quoteReceivedAt: executionAt,
    })),
  };

  bot._processPendingPaperPairs(
    window,
    [arrivalOpportunity],
    null,
    executionAt,
  );

  assert.equal(bot.state.paperTrades.length, 1);
  const trade = bot.state.paperTrades[0];
  assert.equal(trade.pairCostPerShare, 0.78);
  assert.equal(trade.signalPairCostPerShare, 0.75);
  assert.ok(trade.executionPriceDriftPerShare > 0.029);
  assert.ok(trade.simulatedLatencyMs >= 800);
  assert.equal(bot.firedKeys.has(`${window.openMs}:${signal.direction}`), true);
});

test("targets a non-overlapping 500 ms scan and runs venue/benchmark reads concurrently", async () => {
  const currentWindow = engine.windowForTime(Date.now());
  let inFlight = 0;
  let maxInFlight = 0;
  const bot = new ArbitrageBot({
    predictApiKey: "",
    pollMs: 100,
    fetch: async (url) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const parsed = new URL(String(url));
      let body = {};
      if (parsed.hostname === "gamma-api.polymarket.com") body = [];
      if (parsed.pathname.endsWith("/ticker")) {
        body = { price: "100000", time: new Date().toISOString() };
      }
      if (parsed.pathname.endsWith("/candles")) {
        body = [[Math.floor(currentWindow.openMs / 1000), 99_000, 101_000, 100_000, 100_100]];
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  bot._persist = async () => {};
  bot.state.paperTrades = [
    {
      id: "smoke-open-trade",
      finalized: false,
      openMs: currentWindow.openMs,
      closeMs: currentWindow.closeMs,
      direction: "POLY_UP + PREDICT_DOWN",
      legs: [
        { venue: "Polymarket", side: "UP", shares: 2 },
        { venue: "Predict.fun", side: "DOWN", shares: 2 },
      ],
      pairCash: 1.5,
    },
  ];

  assert.equal(bot.pollMs, 500);
  await bot._tick();

  assert.ok(maxInFlight >= 2);
  assert.ok(bot.state.polling.lastCycleMs >= 0);
  assert.equal(bot.state.paperTrades[0].status, "open_provisional");
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
  const priorOpenMs =
    Math.floor((nowMs - 5 * 60 * 1000) / (5 * 60 * 1000)) * 5 * 60 * 1000;
  const market = {
    id: 12,
    title: "Bitcoin Up or Down 5m — prior window",
    slug: `btc-updown-5m-${priorOpenMs / 1000}`,
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
              bids: [
                [0.01, 7007],
                [0.5, 21],
                [0.49, 33],
              ],
              asks: [
                [0.99, 7007],
                [0.54, 20],
                [0.51, 30],
              ],
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
  assert.equal(venue.discovery.source, "exact_search");
  assert.equal(venue.market.id, String(market.id));
  assert.equal(venue.market.startMs, window.openMs);
  assert.equal(venue.market.closeMs, window.closeMs);
  assert.equal(venue.up.bestBid.price, 0.5);
  assert.equal(venue.up.bestAsk.price, 0.51);
  assert.equal(venue.down.bestBid.price, 0.49);
  assert.equal(venue.down.bestAsk.price, 0.5);
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
            JSON.stringify({
              success: true,
              data: {
                categories: [
                  {
                    id: "btc-updown-5m-category",
                    slug,
                    title: "BTC 5m",
                    variantData: { type: "CRYPTO_UP_DOWN" },
                  },
                ],
              },
            }),
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
  assert.equal(venue.discovery.source, "canonical_page_market_id");
  assert.equal(venue.discovery.canonicalPageMarketId, marketId);
});

test("reconciles an expired paper pair from both exact venue markets using read-only GETs", async () => {
  const openMs = Date.UTC(2026, 9, 7, 5, 10);
  const window = { openMs, closeMs: openMs + 5 * 60 * 1000 };
  const slug = `btc-updown-5m-${openMs / 1000}`;
  const polyEvent = {
    slug,
    title: "Bitcoin Up or Down",
    startTime: new Date(window.openMs).toISOString(),
    endDate: new Date(window.closeMs).toISOString(),
    markets: [
      {
        id: "poly-101",
        conditionId: "0xpoly-condition",
        outcomes: '["Up","Down"]',
        clobTokenIds: '["token-up","token-down"]',
        closed: true,
        umaResolutionStatus: "resolved",
        outcomePrices: '["1","0"]',
      },
    ],
  };
  const predictMarket = {
    id: 501,
    slug,
    marketVariant: "CRYPTO_UP_DOWN",
    variantData: { type: "CRYPTO_UP_DOWN" },
    conditionId: "predict-condition",
    status: "RESOLVED",
    outcomes: [
      { name: "Up", indexSet: 1, status: "LOST" },
      { name: "Down", indexSet: 2, status: "WON" },
    ],
    resolution: { name: "Down", index: 2, status: "WON" },
  };
  const requests = [];
  const bot = new ArbitrageBot({
    predictApiKey: "test-only-placeholder",
    stdoutLogger: () => {},
    fetch: async (url, options = {}) => {
      const parsed = new URL(String(url));
      requests.push({
        url: String(url),
        method: options.method || "GET",
        headers: options.headers || {},
      });
      if (parsed.hostname === "gamma-api.polymarket.com") {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([polyEvent]),
        };
      }
      assert.equal(parsed.pathname, "/v1/markets/501");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, data: predictMarket }),
      };
    },
  });
  const trade = {
    id: "known-both-lose",
    openMs: window.openMs,
    closeMs: window.closeMs,
    finalized: false,
    direction: "PREDICT_UP + POLY_DOWN",
    pairCash: 7.5,
    legs: [
      {
        venue: "Predict.fun",
        side: "UP",
        shares: 10,
        marketId: "501",
        marketSlug: slug,
        conditionId: "predict-condition",
      },
      {
        venue: "Polymarket",
        side: "DOWN",
        shares: 10,
        marketId: "poly-101",
        marketSlug: slug,
        conditionId: "0xpoly-condition",
      },
    ],
  };
  bot.state.paperTrades = [trade];

  await bot._processOfficialSettlements(window.closeMs + 1_000);

  assert.equal(trade.finalized, true);
  assert.equal(trade.finalPayout, 0);
  assert.equal(trade.realizedPnl, -7.5);
  assert.equal(trade.venueSettlements.polymarket.outcome, "UP");
  assert.equal(trade.venueSettlements.predict.outcome, "DOWN");
  assert.equal(bot.realizedPnlTotal, -7.5);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.equal(requests[0].headers["x-api-key"], undefined);
  assert.equal(requests[1].headers["x-api-key"], "test-only-placeholder");
});

test("keeps P&L provisional while open, then waits for both official venue results", () => {
  const trade = {
    openMs: 0,
    closeMs: 300_000,
    pairCash: 148.78010975,
    legs: [
      { venue: "Predict.fun", side: "UP", shares: 185.39 },
      { venue: "Polymarket", side: "DOWN", shares: 185.39 },
    ],
  };
  const openBenchmark = {
    openMs: 0,
    closeMs: 300_000,
    openPrice: 100,
    currentPrice: 99,
    finalized: false,
  };
  const beforeClose = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    { ...openBenchmark, currentPrice: 101 },
    null,
    299_999,
  );
  assert.equal(beforeClose.finalized, false);
  assert.equal(beforeClose.status, "open_provisional");
  assert.equal(beforeClose.provisionalOutcome, "UP");
  assert.ok(Math.abs(beforeClose.provisionalPnl - (185.39 - trade.pairCash)) < 1e-9);

  const notYetFinal = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    {
      ...openBenchmark,
      currentPrice: 98,
      finalClosePrice: 98,
      finalized: true,
      finalizedAt: 300_500,
    },
    {
      polymarket: { status: "resolved", outcome: "UP" },
      predict: { status: "pending" },
    },
    300_000,
  );
  assert.equal(notYetFinal.finalized, false);
  assert.equal(notYetFinal.status, "awaiting_official_venue_settlement");
  assert.equal(notYetFinal.provisionalPnl, null);
  assert.equal(notYetFinal.realizedPnl, undefined);

  const bothLose = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    null,
    {
      polymarket: { status: "resolved", outcome: "UP", source: "Polymarket" },
      predict: { status: "resolved", outcome: "DOWN", source: "Predict.fun" },
    },
    300_500,
  );
  assert.equal(bothLose.finalized, true);
  assert.equal(bothLose.status, "finalized_official_venue_settlement");
  assert.equal(bothLose.finalPayout, 0);
  assert.ok(Math.abs(bothLose.realizedPnl + trade.pairCash) < 1e-9);
  assert.equal(bothLose.venueSettlements.polymarket.outcome, "UP");
  assert.equal(bothLose.venueSettlements.predict.outcome, "DOWN");
  assert.equal(bothLose.settlementMethod, "official_venue_markets");
  assert.equal(
    bothLose.settlementLabel,
    "INDEPENDENT_OFFICIAL_VENUE_SETTLEMENT",
  );
});

test("settles a pair leg-by-leg when the two venues resolve differently", () => {
  const trade = {
    openMs: 0,
    closeMs: 300_000,
    pairCash: 7.5,
    legs: [
      { venue: "Polymarket", side: "UP", shares: 10 },
      { venue: "Predict.fun", side: "DOWN", shares: 10 },
    ],
  };
  const oneWin = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    null,
    {
      polymarket: { status: "resolved", outcome: "UP" },
      predict: { status: "resolved", outcome: "UP" },
    },
    301_000,
  );
  assert.equal(oneWin.finalPayout, 10);
  assert.equal(oneWin.realizedPnl, 2.5);
  assert.deepEqual(
    oneWin.legSettlements.map((leg) => leg.payout),
    [10, 0],
  );

  const bothWin = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    null,
    {
      polymarket: { status: "resolved", outcome: "UP" },
      predict: { status: "resolved", outcome: "DOWN" },
    },
    301_000,
  );
  assert.equal(bothWin.finalPayout, 20);
  assert.equal(bothWin.realizedPnl, 12.5);
});

test("migrates old shared-benchmark results to pending without resetting demo capital", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arb-state-migration-"));
  const stateFile = path.join(directory, "arb-state.json");
  const logs = [];
  try {
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        version: 2,
        startingCapitalUsd: 10_000,
        realizedPnlTotal: 36.61,
        paperTrades: [
          {
            id: "legacy-benchmark-trade",
            finalized: true,
            status: "finalized_internal_benchmark",
            settlementLabel: "INTERNAL_BENCHMARK_NOT_OFFICIAL_SETTLEMENT",
            finalOutcome: "UP",
            finalPayout: 185.39,
            realizedPnl: 36.61,
            pairCash: 148.78,
            openMs: 0,
            closeMs: 300_000,
            legs: [
              { venue: "Predict.fun", side: "UP", shares: 185.39 },
              { venue: "Polymarket", side: "DOWN", shares: 185.39 },
            ],
          },
        ],
        events: [],
        firedKeys: [],
      }),
    );
    const bot = new ArbitrageBot({
      stateFile,
      stdoutLogger: (line) => logs.push(JSON.parse(line)),
    });

    await bot._load();

    const trade = bot.state.paperTrades[0];
    assert.equal(bot.startingCapitalUsd, 10_000);
    assert.equal(bot.realizedPnlTotal, 0);
    assert.equal(trade.finalized, false);
    assert.equal(trade.status, "awaiting_official_venue_settlement");
    assert.equal(trade.priorBenchmarkSettlement.pnl, 36.61);
    assert.equal(bot.state.stats.capitalCommitted, 148.78);
    assert.equal(bot.state.stats.availableCapitalUsd, 9_851.22);
    assert.ok(logs.some((entry) => entry.event === "OFFICIAL_SETTLEMENT_MIGRATION"));
    const migratedFile = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(migratedFile.version, 3);
    assert.equal(migratedFile.settlementModel, "independent-venue-v1");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("emits a structured Railway heartbeat every 30 seconds, not every scan tick", () => {
  const logs = [];
  const bot = new ArbitrageBot({
    stdoutLogger: (line) => logs.push(JSON.parse(line)),
  });
  bot.state.window = {
    slug: "btc-updown-5m-1791349800",
    secondsRemaining: 120,
  };
  bot.state.venues.polymarket.status = "connected";
  bot.state.venues.predict.status = "needs_api_key";
  bot.state.opportunities = [
    {
      direction: "POLY_UP + PREDICT_DOWN",
      status: "blocked",
      eligible: false,
      reason: "Missing data",
    },
  ];
  const start = Date.now();

  bot._maybeLogHeartbeat(start);
  bot._maybeLogHeartbeat(start + 29_999);
  bot._maybeLogHeartbeat(start + 30_000);

  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, "BOT_HEARTBEAT");
  assert.equal(logs[0].mode, "PAPER");
  assert.equal(logs[0].component, "btc-cross-venue-paper");
  assert.equal(logs[0].venues.polymarket.status, "connected");
  assert.equal(logs[0].venues.predict.status, "needs_api_key");
});
