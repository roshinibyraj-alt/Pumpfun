"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const engine = require("./arbitrage-engine.js");
const ArbitrageBot = require("./arbitrage-bot.js");

function strategyBook({ ask, bid, size = 1000, observedAt = 100_000 }) {
  return {
    status: "ok",
    observedAt,
    receivedAt: observedAt,
    ageMs: 0,
    requestLatencyMs: 0,
    asks: [{ price: ask, size }],
    bids: [{ price: bid, size }],
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

test("lagging-venue entry requires a $0.90 leader bid and a $0.40–<$0.80 lagging ask", () => {
  const referenceBook = strategyBook({ ask: 0.92, bid: 0.9 });
  const entryBook = {
    ...strategyBook({ ask: 0.4, bid: 0.39 }),
    asks: [
      { price: 0.4, size: 250 },
      { price: 0.45, size: 250 },
    ],
  };
  const result = engine.evaluateLaggingVenueEntry({
    nowMs: 100_000,
    windowOpenMs: 0,
    referenceBook,
    entryBook,
    referenceMarketMatched: true,
    entryMarketMatched: true,
    feeModel: "predict",
    availableCashUsd: 10_000,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.triggerMet, true);
  assert.equal(result.shares, 500);
  assert.equal(result.bestAsk, 0.4);
  assert.equal(result.averagePrice, 0.425);
  assert.equal(result.levelsUsed, 2);
  assert.equal(result.fees, 4.25);
  assert.equal(result.entryCash, 216.75);
});

test("rejects lagging asks below $0.40, at $0.80, or with leader bid below $0.90", () => {
  const evaluate = (entryAsk, referenceBid) =>
    engine.evaluateLaggingVenueEntry({
      nowMs: 100_000,
      windowOpenMs: 0,
      referenceBook: strategyBook({ ask: 0.95, bid: referenceBid }),
      entryBook: strategyBook({ ask: entryAsk, bid: Math.max(0.01, entryAsk - 0.01) }),
      referenceMarketMatched: true,
      entryMarketMatched: true,
      feeModel: "polymarket",
      availableCashUsd: 10_000,
    });
  assert.equal(evaluate(0.39, 0.95).eligible, false);
  assert.equal(evaluate(0.8, 0.95).eligible, false);
  assert.equal(evaluate(0.7, 0.95).eligible, true);
  assert.equal(evaluate(0.79, 0.95).eligible, true);
  assert.equal(evaluate(0.5, 0.899).eligible, false);
  assert.equal(evaluate(0.5, 0.95).eligible, true);
});

test("lagging-venue entry requires 500 shares of visible depth and stops opening at 270 seconds", () => {
  const shared = {
    referenceBook: strategyBook({ ask: 0.95, bid: 0.91 }),
    referenceMarketMatched: true,
    entryMarketMatched: true,
    feeModel: "predict",
    windowOpenMs: 0,
  };
  const shallow = engine.evaluateLaggingVenueEntry({
    ...shared,
    nowMs: 100_000,
    entryBook: strategyBook({ ask: 0.45, bid: 0.44, size: 499 }),
    availableCashUsd: 10_000,
  });
  assert.equal(shallow.eligible, false);
  assert.equal(shallow.status, "insufficient_depth");

  const exactlyAtCutoff = engine.evaluateLaggingVenueEntry({
    ...shared,
    nowMs: 270_000,
    referenceBook: strategyBook({ ask: 0.95, bid: 0.91, observedAt: 270_000 }),
    entryBook: strategyBook({ ask: 0.45, bid: 0.44, observedAt: 270_000 }),
    availableCashUsd: 10_000,
  });
  assert.equal(exactlyAtCutoff.triggerMet, true);
  assert.equal(exactlyAtCutoff.eligible, false);
  assert.equal(exactlyAtCutoff.status, "cutoff");

  const noCapital = engine.evaluateLaggingVenueEntry({
    ...shared,
    nowMs: 100_000,
    entryBook: strategyBook({ ask: 0.45, bid: 0.44 }),
    availableCashUsd: 0,
  });
  assert.equal(noCapital.triggerMet, true);
  assert.equal(noCapital.eligible, false);
  assert.equal(noCapital.status, "insufficient_capital");
});

test("lagging-venue entry rejects stale books and unsafe cross-venue market matches", () => {
  const freshReference = strategyBook({ ask: 0.95, bid: 0.91 });
  const freshEntry = strategyBook({ ask: 0.45, bid: 0.44 });
  const stale = engine.evaluateLaggingVenueEntry({
    nowMs: 100_000,
    windowOpenMs: 0,
    referenceBook: { ...freshReference, observedAt: 90_000, receivedAt: 90_000 },
    entryBook: freshEntry,
    referenceMarketMatched: true,
    entryMarketMatched: true,
    feeModel: "polymarket",
    availableCashUsd: 10_000,
  });
  assert.equal(stale.eligible, false);
  assert.match(stale.reason, /stale/);

  const unmatched = engine.evaluateLaggingVenueEntry({
    nowMs: 100_000,
    windowOpenMs: 0,
    referenceBook: freshReference,
    entryBook: freshEntry,
    referenceMarketMatched: true,
    entryMarketMatched: false,
    feeModel: "polymarket",
    availableCashUsd: 10_000,
  });
  assert.equal(unmatched.eligible, false);
  assert.match(unmatched.reason, /safely matched/);
});

test("enforces one re-entry per side only after the first position exits", () => {
  const bot = new ArbitrageBot();
  const window = { openMs: 0, closeMs: 300_000 };
  const poly = {
    market: { matchStatus: "matched", id: "poly", conditionId: "poly-condition" },
    up: strategyBook({ ask: 0.93, bid: 0.9 }),
    down: strategyBook({ ask: 0.5, bid: 0.49 }),
  };
  const predict = {
    market: { matchStatus: "matched", id: "predict", conditionId: "predict-condition" },
    up: strategyBook({ ask: 0.4, bid: 0.39 }),
    down: strategyBook({ ask: 0.5, bid: 0.49 }),
  };
  const direction = "BUY UP on Predict.fun · Polymarket confirms";
  const first = bot._evaluate(window, poly, predict, 100_000);
  assert.equal(first.find((item) => item.direction === direction).eligible, true);

  bot.state.paperTrades.push({
    id: "open-up",
    strategyVersion: "lagging-venue-v1",
    side: "UP",
    openMs: 0,
    finalized: false,
    entryCash: 205,
  });
  assert.equal(
    bot._evaluate(window, poly, predict, 100_000).find((item) => item.direction === direction)
      .eligible,
    false,
  );

  bot.state.paperTrades[0].finalized = true;
  bot.state.paperTrades[0].settlementMethod = "simulated_stop_loss";
  assert.equal(
    bot._evaluate(window, poly, predict, 100_000).find((item) => item.direction === direction)
      .eligible,
    true,
  );
  bot.state.paperTrades.push({
    id: "reentry-up",
    strategyVersion: "lagging-venue-v1",
    side: "UP",
    openMs: 0,
    finalized: true,
    settlementMethod: "simulated_take_profit",
    pairCash: 205,
  });
  const afterReentry = bot._evaluate(window, poly, predict, 100_000);
  assert.equal(afterReentry.find((item) => item.direction === direction).eligible, false);
  assert.equal(afterReentry.find((item) => item.direction === direction).entryCount, 2);
});

test("opens one lagging-side position only after delayed fresh snapshots, then cannot fill after 270 seconds", () => {
  const window = { openMs: 0, closeMs: 300_000 };
  const makeVenues = (observedAt) => ({
    poly: {
      market: { matchStatus: "matched", id: "poly", conditionId: "poly-condition" },
      up: strategyBook({ ask: 0.93, bid: 0.9, observedAt }),
      down: strategyBook({ ask: 0.5, bid: 0.49, observedAt }),
    },
    predict: {
      market: { matchStatus: "matched", id: "predict", conditionId: "predict-condition" },
      up: strategyBook({ ask: 0.4, bid: 0.39, observedAt }),
      down: strategyBook({ ask: 0.5, bid: 0.49, observedAt }),
    },
  });
  const bot = new ArbitrageBot({ paperBaseLatencyMs: 100 });
  const detectedAt = 100_000;
  const initialVenues = makeVenues(detectedAt);
  const initial = bot._evaluate(window, initialVenues.poly, initialVenues.predict, detectedAt);
  const upEntry = initial.find(
    (item) => item.side === "UP" && item.entryVenue === "Predict.fun",
  );
  assert.equal(upEntry.eligible, true);
  bot._schedulePaperEntries(window, [upEntry], detectedAt);
  const pending = bot.pendingPaperEntries.get(`${window.openMs}:UP`);
  assert.ok(pending);
  bot._schedulePaperEntries(window, [upEntry], detectedAt + 20);
  assert.equal(bot.pendingPaperEntries.size, 1);

  const fillAt = pending.simulatedArrivalAt;
  const arrivedVenues = makeVenues(fillAt);
  const arrivalOpportunities = bot._evaluate(
    window,
    arrivedVenues.poly,
    arrivedVenues.predict,
    fillAt,
  );
  bot._processPendingPaperEntries(window, arrivalOpportunities, null, fillAt);
  assert.equal(bot.state.paperTrades.length, 1);
  const trade = bot.state.paperTrades[0];
  assert.equal(trade.strategyVersion, "lagging-venue-v1");
  assert.equal(trade.venue, "Predict.fun");
  assert.equal(trade.side, "UP");
  assert.equal(trade.shares, 500);
  assert.equal(trade.legs.length, 1);
  bot._schedulePaperEntries(window, [upEntry], fillAt + 10);
  assert.equal(bot.pendingPaperEntries.size, 0);
  trade.finalized = true;
  trade.settlementMethod = "simulated_take_profit";
  trade.realizedPnl = 295;
  const clearedVenues = makeVenues(fillAt + 20);
  clearedVenues.poly.up.bids[0].price = 0.89;
  clearedVenues.predict.up.asks[0].price = 0.39;
  const clearedEntry = bot
    ._evaluate(window, clearedVenues.poly, clearedVenues.predict, fillAt + 20)
    .find((item) => item.side === "UP" && item.entryVenue === "Predict.fun");
  assert.equal(clearedEntry.triggerMet, false);
  bot._schedulePaperEntries(window, [clearedEntry], fillAt + 20);

  const rearmedVenues = makeVenues(fillAt + 30);
  const reentry = bot
    ._evaluate(window, rearmedVenues.poly, rearmedVenues.predict, fillAt + 30)
    .find((item) => item.side === "UP" && item.entryVenue === "Predict.fun");
  assert.equal(reentry.entryCount, 1);
  assert.equal(reentry.eligible, true);
  bot._schedulePaperEntries(window, [reentry], fillAt + 30);
  assert.equal(bot.pendingPaperEntries.size, 1);

  const lateBot = new ArbitrageBot({ paperBaseLatencyMs: 500 });
  const lateDetectedAt = 269_900;
  const lateVenues = makeVenues(lateDetectedAt);
  const lateOpportunity = lateBot
    ._evaluate(window, lateVenues.poly, lateVenues.predict, lateDetectedAt)
    .find((item) => item.side === "UP" && item.entryVenue === "Predict.fun");
  assert.equal(lateOpportunity.eligible, true);
  lateBot._schedulePaperEntries(window, [lateOpportunity], lateDetectedAt);
  lateBot._processPendingPaperEntries(
    window,
    [lateOpportunity],
    null,
    270_000,
  );
  assert.equal(lateBot.state.paperTrades.length, 0);
  assert.equal(lateBot.pendingPaperEntries.size, 0);
});

test("TP credits $1 per share after delayed confirmation; stop exits against bid depth and fees", () => {
  const window = { openMs: 0, closeMs: 300_000 };
  const makeTrade = (venue, side, feeModel, entryCash) => ({
    id: `${venue}-${side}`,
    strategyVersion: "lagging-venue-v1",
    openMs: 0,
    closeMs: 300_000,
    side,
    venue,
    shares: 500,
    entryCash,
    fees: 5,
    finalized: false,
    legs: [{ feeModel }],
  });
  const tpBot = new ArbitrageBot({ paperBaseLatencyMs: 100 });
  const tpTrade = makeTrade("Polymarket", "UP", "polymarket", 205);
  tpBot.state.paperTrades = [tpTrade];
  tpBot.state.venues.polymarket.up = {
    ...strategyBook({ ask: 1, bid: 0.99 }),
    requestLatencyMs: 0,
  };
  tpBot._processPaperPositionExits(window, 100_000);
  assert.equal(tpTrade.finalized, false);
  assert.equal(tpTrade.pendingExit.type, "take_profit");
  const tpArrival = tpTrade.pendingExit.simulatedArrivalAt;
  tpBot.state.venues.polymarket.up = {
    ...strategyBook({ ask: 1, bid: 0.99, observedAt: tpArrival }),
    requestLatencyMs: 0,
  };
  tpBot._processPaperPositionExits(window, tpArrival);
  assert.equal(tpTrade.finalized, true);
  assert.equal(tpTrade.settlementMethod, "simulated_take_profit");
  assert.equal(tpTrade.finalPayout, 500);
  assert.equal(tpTrade.realizedPnl, 295);

  const stopBot = new ArbitrageBot({ paperBaseLatencyMs: 100 });
  const stopTrade = makeTrade("Predict.fun", "DOWN", "predict", 205);
  stopBot.state.paperTrades = [stopTrade];
  stopBot.state.venues.predict.down = {
    ...strategyBook({ ask: 0.31, bid: 0.3, size: 500 }),
    requestLatencyMs: 0,
  };
  stopBot._processPaperPositionExits(window, 100_000);
  const stopArrival = stopTrade.pendingExit.simulatedArrivalAt;
  stopBot.state.venues.predict.down = {
    ...strategyBook({ ask: 0.31, bid: 0.3, size: 500, observedAt: stopArrival }),
    requestLatencyMs: 0,
  };
  stopBot._processPaperPositionExits(window, stopArrival);
  assert.equal(stopTrade.finalized, true);
  assert.equal(stopTrade.settlementMethod, "simulated_stop_loss");
  assert.equal(stopTrade.exitPrice, 0.3);
  assert.equal(stopTrade.exitFees, 3);
  assert.equal(stopTrade.finalPayout, 147);
  assert.equal(stopTrade.realizedPnl, -58);
});

test("a single-venue position settles from only the venue that holds its shares", () => {
  const trade = {
    id: "single-poly-up",
    openMs: 0,
    closeMs: 300_000,
    side: "UP",
    entryCash: 205,
    finalized: false,
    legs: [{ venue: "Polymarket", side: "UP", shares: 500 }],
  };
  const settled = engine.updateTradeWithOfficialVenueSettlement(
    trade,
    null,
    {
      polymarket: { status: "resolved", outcome: "UP" },
      predict: { status: "pending" },
    },
    300_000,
  );
  assert.equal(settled.finalized, true);
  assert.equal(settled.finalOutcome, "Polymarket UP");
  assert.equal(settled.finalPayout, 500);
  assert.equal(settled.realizedPnl, 295);
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

test("shows Predict quotes for an unmatched market without allowing a paper entry", async () => {
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
    assert.equal(migratedFile.version, 4);
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
