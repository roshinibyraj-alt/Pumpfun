"use strict";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BOOK_AGE_MS = 8000;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toTimestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function windowForTime(timestampMs) {
  const openMs = Math.floor(Number(timestampMs) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  return { openMs, closeMs: openMs + FIVE_MINUTES_MS };
}

function windowsMatch(left, right) {
  return Boolean(
    left &&
      right &&
      Number(left.openMs) === Number(right.openMs) &&
      Number(left.closeMs) === Number(right.closeMs),
  );
}

function normalizeLevels(levels, side = "asks") {
  if (!Array.isArray(levels)) return [];
  const normalized = levels
    .map((level) => {
      const price = finiteNumber(Array.isArray(level) ? level[0] : level?.price);
      const size = finiteNumber(
        Array.isArray(level) ? level[1] : level?.size ?? level?.quantity,
      );
      if (price === null || size === null || price < 0 || price > 1 || size <= 0) {
        return null;
      }
      return { price, size };
    })
    .filter(Boolean);
  normalized.sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price));
  return normalized;
}

function complementPrice(price, decimalPrecision) {
  const precision = Math.max(0, Math.min(8, Math.floor(Number(decimalPrecision) || 0)));
  const scale = 10 ** precision;
  return Math.round((1 - Number(price)) * scale + Number.EPSILON) / scale;
}

function complementYesBook(yesBook, decimalPrecision = 2) {
  const yesAsks = normalizeLevels(yesBook?.asks, "asks");
  const yesBids = normalizeLevels(yesBook?.bids, "bids");
  const noAsks = yesBids
    .map(({ price, size }) => ({ price: complementPrice(price, decimalPrecision), size }))
    .sort((a, b) => a.price - b.price);
  const noBids = yesAsks
    .map(({ price, size }) => ({ price: complementPrice(price, decimalPrecision), size }))
    .sort((a, b) => b.price - a.price);
  return {
    yes: { asks: yesAsks, bids: yesBids },
    no: { asks: noAsks, bids: noBids },
  };
}

function polymarketTakerFee(shares, price) {
  const quantity = Number(shares);
  const probability = Number(price);
  return quantity * 0.07 * probability * (1 - probability);
}

function predictTakerFee(shares, price) {
  const quantity = Number(shares);
  const probability = Number(price);
  return quantity * 0.02 * Math.min(probability, 1 - probability);
}

function feeForModel(model, shares, price) {
  if (model === "polymarket") return polymarketTakerFee(shares, price);
  if (model === "predict") return predictTakerFee(shares, price);
  throw new Error(`Unknown fee model: ${String(model)}`);
}

function walkAsks(asks, shares, feeModel) {
  let remaining = Number(shares);
  let notional = 0;
  let fees = 0;
  let worstPrice = null;
  let levelsUsed = 0;
  const fills = [];
  for (const level of normalizeLevels(asks, "asks")) {
    if (remaining <= 1e-8) break;
    const quantity = Math.min(remaining, level.size);
    if (quantity <= 0) continue;
    notional += quantity * level.price;
    fees += feeForModel(feeModel, quantity, level.price);
    remaining -= quantity;
    worstPrice = level.price;
    levelsUsed += 1;
    fills.push({ price: level.price, shares: quantity });
  }
  if (remaining > 1e-6) return null;
  return {
    shares: Number(shares),
    notional,
    fees,
    cash: notional + fees,
    averagePrice: notional / Number(shares),
    worstPrice,
    levelsUsed,
    fills,
  };
}

function walkBids(bids, shares, feeModel) {
  let remaining = Number(shares);
  let notional = 0;
  let fees = 0;
  let worstPrice = null;
  let levelsUsed = 0;
  const fills = [];
  for (const level of normalizeLevels(bids, "bids")) {
    if (remaining <= 1e-8) break;
    const quantity = Math.min(remaining, level.size);
    if (quantity <= 0) continue;
    notional += quantity * level.price;
    fees += feeForModel(feeModel, quantity, level.price);
    remaining -= quantity;
    worstPrice = level.price;
    levelsUsed += 1;
    fills.push({ price: level.price, shares: quantity });
  }
  if (remaining > 1e-6) return null;
  return {
    shares: Number(shares),
    notional,
    fees,
    proceeds: notional - fees,
    averagePrice: notional / Number(shares),
    worstPrice,
    levelsUsed,
    fills,
  };
}

function checkBookFresh(book, nowMs, maxBookAgeMs = DEFAULT_MAX_BOOK_AGE_MS) {
  if (!book || book.status !== "ok") {
    return { ok: false, reason: book?.error || "Book is missing or unavailable." };
  }
  const observedAt = finiteNumber(book.observedAt);
  if (observedAt === null) return { ok: false, reason: "Book timestamp is missing." };
  const ageMs = Number(nowMs) - observedAt;
  if (ageMs < -1000) return { ok: false, reason: "Book timestamp is in the future." };
  if (ageMs > maxBookAgeMs) {
    return { ok: false, reason: `Book is stale (${Math.round(ageMs)} ms old).` };
  }
  if (!normalizeLevels(book.asks, "asks").length) {
    return { ok: false, reason: "No executable ask depth." };
  }
  return { ok: true, ageMs: Math.max(0, ageMs) };
}

function evaluateLaggingVenueEntry(options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const shares = Number(options.shares ?? 500);
  const referenceBidThreshold = Number(options.referenceBidThreshold ?? 0.97);
  const minimumEntryAsk = Number(options.minimumEntryAsk ?? 0.6);
  const maximumEntryAsk = Number(options.maximumEntryAsk ?? 0.9);
  const maxEntrySeconds = Number(options.maxEntrySeconds ?? 270);
  const maxBookAgeMs = Number(options.maxBookAgeMs ?? DEFAULT_MAX_BOOK_AGE_MS);
  const maxBookSkewMs = finiteNumber(options.maxBookSkewMs);
  const referenceBook = options.referenceBook;
  const entryBook = options.entryBook;
  const blocked = (reason, extra = {}) => ({
    status: "blocked",
    eligible: false,
    triggerMet: false,
    signalObserved: false,
    reason,
    ...extra,
  });

  if (!Number.isFinite(shares) || shares <= 0) {
    return blocked("Paper share quantity must be positive.");
  }
  if (options.referenceMarketMatched !== true || options.entryMarketMatched !== true) {
    return blocked(
      options.matchReason || "Both venue markets must be safely matched to the same window.",
    );
  }
  const referenceFresh = checkBookFresh(referenceBook, nowMs, maxBookAgeMs);
  if (!referenceFresh.ok) {
    return blocked(`Reference venue book: ${referenceFresh.reason}`);
  }
  const entryFresh = checkBookFresh(entryBook, nowMs, maxBookAgeMs);
  if (!entryFresh.ok) {
    return blocked(`Entry venue book: ${entryFresh.reason}`);
  }
  const snapshotTimes = [
    finiteNumber(referenceBook?.receivedAt ?? referenceBook?.observedAt),
    finiteNumber(entryBook?.receivedAt ?? entryBook?.observedAt),
  ];
  if (snapshotTimes.some((value) => value === null)) {
    return blocked("A venue book timestamp is missing.");
  }
  const snapshotSkewMs = Math.max(...snapshotTimes) - Math.min(...snapshotTimes);
  if (maxBookSkewMs !== null && snapshotSkewMs > maxBookSkewMs) {
    return blocked(
      `Venue book snapshots are ${Math.round(snapshotSkewMs)} ms apart; the limit is ${Math.round(maxBookSkewMs)} ms.`,
      { snapshotSkewMs },
    );
  }

  const referenceBid = normalizeLevels(referenceBook?.bids, "bids")[0]?.price ?? null;
  const entryAsk = normalizeLevels(entryBook?.asks, "asks")[0]?.price ?? null;
  if (referenceBid === null) return blocked("Reference venue has no executable best bid.");
  if (entryAsk === null) return blocked("Entry venue has no executable best ask.");
  const signalObserved = true;
  const triggerMet =
    referenceBid + 1e-9 >= referenceBidThreshold &&
    entryAsk + 1e-9 >= minimumEntryAsk &&
    entryAsk < maximumEntryAsk - 1e-9;
  const observed = {
    referenceBid,
    entryAsk,
    snapshotSkewMs,
    signalObserved,
    triggerMet,
    referenceBidThreshold,
    minimumEntryAsk,
    maximumEntryAsk,
  };
  if (!triggerMet) {
    return {
      status: "below_threshold",
      eligible: false,
      reason: `Waiting for reference best bid ≥ $${referenceBidThreshold.toFixed(2)} and entry best ask in [$${minimumEntryAsk.toFixed(2)}, $${maximumEntryAsk.toFixed(2)}).`,
      ...observed,
    };
  }

  const windowOpenMs = finiteNumber(options.windowOpenMs);
  if (windowOpenMs === null || nowMs < windowOpenMs) {
    return {
      status: "blocked",
      eligible: false,
      reason: "The matching five-minute window has not started.",
      ...observed,
    };
  }
  const elapsedSeconds = (nowMs - windowOpenMs) / 1000;
  if (elapsedSeconds >= maxEntrySeconds) {
    return {
      status: "cutoff",
      eligible: false,
      reason: `No new entries after ${maxEntrySeconds} seconds of the window.`,
      elapsedSeconds,
      ...observed,
    };
  }

  const eligibleAsks = normalizeLevels(entryBook?.asks, "asks").filter(
    (level) => level.price >= minimumEntryAsk && level.price < maximumEntryAsk,
  );
  const fill = walkAsks(eligibleAsks, shares, options.feeModel);
  if (!fill) {
    return {
      status: "insufficient_depth",
      eligible: false,
      reason: `Fewer than ${shares} shares are executable below $${maximumEntryAsk.toFixed(2)} on the entry venue.`,
      elapsedSeconds,
      ...observed,
    };
  }
  const availableCash = finiteNumber(options.availableCashUsd);
  if (availableCash !== null && fill.cash > availableCash + 1e-6) {
    return {
      status: "insufficient_capital",
      eligible: false,
      reason: `The $${fill.cash.toFixed(2)} paper entry exceeds available demo capital of $${availableCash.toFixed(2)}.`,
      elapsedSeconds,
      shares,
      entryCash: fill.cash,
      ...observed,
    };
  }

  const bestAsk = eligibleAsks[0]?.price ?? null;
  return {
    status: "trigger",
    eligible: true,
    reason: `Reference best bid reached $${referenceBid.toFixed(2)} while the other venue's same-side best ask is $${entryAsk.toFixed(2)}; paper-buying ${shares} shares on executable depth.`,
    shares,
    entryCash: fill.cash,
    notional: fill.notional,
    fees: fill.fees,
    averagePrice: fill.averagePrice,
    bestAsk,
    worstFillPrice: fill.worstPrice,
    depthSlippagePerShare: bestAsk === null ? null : Math.max(0, fill.averagePrice - bestAsk),
    levelsUsed: fill.levelsUsed,
    fills: fill.fills,
    elapsedSeconds,
    ...observed,
  };
}

function normalizedOutcomeName(outcome) {
  if (typeof outcome === "string") return outcome.trim().toUpperCase();
  return String(outcome?.name ?? outcome?.title ?? outcome?.label ?? "")
    .trim()
    .toUpperCase();
}

function parseOutcomeList(raw) {
  let outcomes = raw;
  if (typeof outcomes === "string") {
    try {
      outcomes = JSON.parse(outcomes);
    } catch {
      return [];
    }
  }
  if (outcomes && Array.isArray(outcomes.edges)) {
    return outcomes.edges.map((edge) => edge?.node ?? edge).filter(Boolean);
  }
  if (outcomes && Array.isArray(outcomes.nodes)) return outcomes.nodes;
  return Array.isArray(outcomes) ? outcomes : [];
}

function mapPredictUpDownOutcomes(market) {
  const variant = String(market?.variantData?.type ?? market?.marketVariant ?? "")
    .trim()
    .toUpperCase();
  if (variant !== "CRYPTO_UP_DOWN") {
    return { safe: false, reason: "Market is not explicitly tagged CRYPTO_UP_DOWN." };
  }
  const outcomes = parseOutcomeList(market?.outcomes);
  if (outcomes.length !== 2) {
    return {
      safe: false,
      reason: `Expected exactly 2 outcomes; received ${outcomes.length}. Flat or other outcomes disable scanning.`,
    };
  }
  const firstName = normalizedOutcomeName(outcomes[0]);
  const secondName = normalizedOutcomeName(outcomes[1]);
  const firstIndex = Number(outcomes[0]?.indexSet ?? outcomes[0]?.index);
  const secondIndex = Number(outcomes[1]?.indexSet ?? outcomes[1]?.index);
  if (
    firstName !== "UP" ||
    secondName !== "DOWN" ||
    firstIndex !== 1 ||
    secondIndex !== 2
  ) {
    return {
      safe: false,
      reason:
        "Cannot safely map Predict's Yes-only book to UP/DOWN; expected UP at indexSet 1 and DOWN at indexSet 2.",
    };
  }
  return { safe: true, yesSide: "UP", noSide: "DOWN", outcomes };
}

function getExplicitMarketWindow(market) {
  const slug = String(market?.slug ?? "");
  const fiveMinuteSlug = /^btc-updown-5m-(\d+)$/.exec(slug);
  if (fiveMinuteSlug) {
    const openSeconds = Number(fiveMinuteSlug[1]);
    const openMs = openSeconds * 1000;
    if (
      Number.isSafeInteger(openSeconds) &&
      Number.isSafeInteger(openMs) &&
      openMs % FIVE_MINUTES_MS === 0
    ) {
      return { openMs, closeMs: openMs + FIVE_MINUTES_MS };
    }
  }
  const records = [
    market,
    market?.variantData,
    market?.variantDetails?.crypto,
    market?.variantDetails?.cryptoUpDown,
  ].filter(Boolean);
  const startKeys = [
    "windowStart",
    "windowStartTime",
    "startTime",
    "startDate",
    "eventStartTime",
    "openTime",
    "opensAt",
  ];
  const endKeys = [
    "windowEnd",
    "windowEndTime",
    "endTime",
    "endDate",
    "eventEndTime",
    "closeTime",
    "closesAt",
    "expiresAt",
  ];
  let openMs = null;
  let closeMs = null;
  for (const record of records) {
    if (openMs === null) {
      for (const key of startKeys) {
        openMs = toTimestampMs(record[key]);
        if (openMs !== null) break;
      }
    }
    if (closeMs === null) {
      for (const key of endKeys) {
        closeMs = toTimestampMs(record[key]);
        if (closeMs !== null) break;
      }
    }
  }
  return openMs !== null && closeMs !== null ? { openMs, closeMs } : null;
}

function evaluatePredictMarketMatch(market, expectedWindow, polymarketConditionId) {
  const outcomeMapping = mapPredictUpDownOutcomes(market);
  if (!outcomeMapping.safe) {
    return { matched: false, reason: outcomeMapping.reason, outcomeMapping };
  }
  const tradingStatus = market?.tradingStatus ?? market?.status;
  if (tradingStatus && String(tradingStatus).toUpperCase() !== "OPEN") {
    return {
      matched: false,
      reason: `Predict market trading status is ${tradingStatus}, not OPEN.`,
      outcomeMapping,
    };
  }
  const expectedId = String(polymarketConditionId || "").toLowerCase();
  const linkedIds = Array.isArray(market?.polymarketConditionIds)
    ? market.polymarketConditionIds.map((id) => String(id).toLowerCase())
    : [];
  const linked = Boolean(expectedId && linkedIds.includes(expectedId));
  const explicitWindow = getExplicitMarketWindow(market);
  const exactWindow = windowsMatch(explicitWindow, expectedWindow);
  if (!linked && !exactWindow) {
    return {
      matched: false,
      reason:
        "No exact 5-minute match: Predict provides neither matching explicit window boundaries nor the Polymarket condition ID link. Similar titles are not enough.",
      outcomeMapping,
      explicitWindow,
    };
  }
  return {
    matched: true,
    matchMethod: linked
      ? "polymarket_condition_id"
      : /^btc-updown-5m-\d+$/.test(String(market?.slug ?? ""))
        ? "slug_window"
        : "explicit_window",
    reason: linked
      ? "Matched by Predict's explicit Polymarket condition ID link."
      : /^btc-updown-5m-\d+$/.test(String(market?.slug ?? ""))
        ? "Matched by the exact UTC 5-minute slot encoded in Predict's market slug."
        : "Matched by exact 5-minute start and end timestamps.",
    outcomeMapping,
    explicitWindow: explicitWindow || expectedWindow,
  };
}

function benchmarkOutcome(openPrice, closePrice) {
  const open = finiteNumber(openPrice);
  const close = finiteNumber(closePrice);
  if (open === null || close === null) return null;
  return close >= open ? "UP" : "DOWN";
}

function getPolymarketResolvedOutcome(market) {
  const outcomes = parseOutcomeList(market?.outcomes);
  const names = outcomes.map(normalizedOutcomeName);
  if (names.length !== 2 || !names.includes("UP") || !names.includes("DOWN")) {
    return null;
  }
  const prices = parseOutcomeList(market?.outcomePrices).map(finiteNumber);
  if (prices.length !== 2 || prices.some((price) => price === null)) return null;
  if (
    market?.closed === false ||
    String(market?.closed).toLowerCase() === "false" ||
    market?.resolved === false
  ) {
    return null;
  }
  const closeConfirmed =
    market?.closed === true ||
    String(market?.closed).toLowerCase() === "true" ||
    market?.resolved === true ||
    String(market?.umaResolutionStatus ?? market?.resolutionStatus ?? market?.status)
      .toLowerCase() === "resolved";
  if (!closeConfirmed) return null;
  const winners = prices
    .map((price, index) => (price >= 1 - 1e-6 ? index : -1))
    .filter((index) => index >= 0);
  const losers = prices
    .map((price, index) => (price <= 1e-6 ? index : -1))
    .filter((index) => index >= 0);
  if (winners.length !== 1 || losers.length !== 1 || winners[0] === losers[0]) {
    return null;
  }
  return names[winners[0]];
}

function resolvedPredictOutcomeName(value, outcomes) {
  const name = normalizedOutcomeName(value);
  if (name === "UP" || name === "DOWN") return name;
  const index = Number(value?.indexSet ?? value?.index);
  if (!Number.isFinite(index)) return null;
  const matched = outcomes.find(
    (outcome) => Number(outcome?.indexSet ?? outcome?.index) === index,
  );
  const matchedName = normalizedOutcomeName(matched);
  return matchedName === "UP" || matchedName === "DOWN" ? matchedName : null;
}

function getPredictResolvedOutcome(market) {
  if (String(market?.status ?? market?.tradingStatus ?? "").toUpperCase() !== "RESOLVED") {
    return null;
  }
  const mapping = mapPredictUpDownOutcomes(market);
  if (!mapping.safe) return null;
  const outcomes = mapping.outcomes;
  const winnerRecords = outcomes.filter(
    (outcome) => String(outcome?.status ?? "").toUpperCase() === "WON",
  );
  const statusRecords = outcomes.filter((outcome) => outcome?.status != null);
  if (
    (statusRecords.length > 0 &&
      (winnerRecords.length !== 1 ||
        outcomes.some(
          (outcome) => !["WON", "LOST"].includes(String(outcome?.status).toUpperCase()),
        ))) ||
    winnerRecords.length > 1
  ) {
    return null;
  }
  const outcomeFromRecords =
    winnerRecords.length === 1 ? normalizedOutcomeName(winnerRecords[0]) : null;
  const resolution = market?.resolution;
  if (
    resolution?.status != null &&
    String(resolution.status).toUpperCase() !== "WON"
  ) {
    return null;
  }
  const outcomeFromResolution = resolution
    ? resolvedPredictOutcomeName(resolution, outcomes)
    : null;
  if (resolution && !outcomeFromResolution) return null;
  if (
    outcomeFromRecords &&
    outcomeFromResolution &&
    outcomeFromRecords !== outcomeFromResolution
  ) {
    return null;
  }
  return outcomeFromResolution || outcomeFromRecords || null;
}

function pairPayoutForOutcome(trade, outcome) {
  if (outcome !== "UP" && outcome !== "DOWN") return null;
  return (trade.legs || []).reduce(
    (sum, leg) => sum + (String(leg.side).toUpperCase() === outcome ? Number(leg.shares) : 0),
    0,
  );
}

function venueKey(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("poly")) return "polymarket";
  if (normalized.includes("predict")) return "predict";
  return null;
}

function settlementForVenue(settlements, key) {
  const raw = settlements?.[key] ??
    settlements?.[key === "polymarket" ? "Polymarket" : "Predict.fun"];
  if (typeof raw === "string") {
    return ["UP", "DOWN"].includes(raw.toUpperCase())
      ? { status: "resolved", outcome: raw.toUpperCase() }
      : { status: "pending", outcome: null };
  }
  if (!raw || typeof raw !== "object") return { status: "pending", outcome: null };
  const outcome = String(raw.outcome ?? "").toUpperCase();
  const rawStatus = String(raw.status ?? "pending").toLowerCase();
  const status =
    rawStatus === "resolved" && (outcome === "UP" || outcome === "DOWN")
      ? "resolved"
      : rawStatus;
  return {
    status,
    outcome: status === "resolved" ? outcome : null,
    marketId: raw.marketId ?? null,
    marketSlug: raw.marketSlug ?? null,
    conditionId: raw.conditionId ?? null,
    source: raw.source ?? null,
    resolvedAt: finiteNumber(raw.resolvedAt),
    reason: raw.reason ?? null,
  };
}

function updateTradeWithOfficialVenueSettlement(
  trade,
  benchmark,
  venueSettlements,
  nowMs = Date.now(),
) {
  if (
    trade.finalized === true &&
    trade.settlementMethod === "official_venue_markets"
  ) {
    return trade;
  }
  const base = { ...trade, finalized: false };
  const sameWindow =
    Number(benchmark?.openMs) === Number(trade.openMs) &&
    Number(benchmark?.closeMs) === Number(trade.closeMs);
  if (Number(nowMs) < Number(trade.closeMs)) {
    if (!sameWindow || finiteNumber(benchmark?.openPrice) === null) {
      return {
        ...base,
        status: "open_benchmark_unavailable",
        provisionalOutcome: null,
        provisionalPayout: null,
        provisionalPnl: null,
      };
    }
    const outcome = benchmarkOutcome(benchmark.openPrice, benchmark.currentPrice);
    const payout = outcome ? pairPayoutForOutcome(trade, outcome) : null;
    return {
      ...base,
      status: "open_provisional",
      provisionalOutcome: outcome,
      provisionalPayout: payout,
      provisionalPnl:
        payout === null
          ? null
          : payout - Number(trade.entryCash ?? trade.pairCash),
    };
  }
  const normalizedSettlements = {
    polymarket: settlementForVenue(venueSettlements, "polymarket"),
    predict: settlementForVenue(venueSettlements, "predict"),
  };
  const requiredVenues = new Set((trade.legs || []).map((leg) => venueKey(leg.venue)));
  const allRequiredVenuesResolved =
    requiredVenues.size > 0 &&
    [...requiredVenues].every(
      (key) => normalizedSettlements[key]?.status === "resolved",
    );
  if (!allRequiredVenuesResolved) {
    return {
      ...base,
      status: "awaiting_official_venue_settlement",
      venueSettlements: normalizedSettlements,
      provisionalOutcome: null,
      provisionalPayout: null,
      provisionalPnl: null,
    };
  }
  const legSettlements = [];
  for (const leg of trade.legs || []) {
    const key = venueKey(leg.venue);
    const outcome = normalizedSettlements[key]?.outcome;
    const shares = finiteNumber(leg.shares);
    const side = String(leg.side ?? "").toUpperCase();
    if (!outcome || shares === null || shares < 0 || !["UP", "DOWN"].includes(side)) {
      return {
        ...base,
        status: "awaiting_official_venue_settlement",
        venueSettlements: normalizedSettlements,
        provisionalOutcome: null,
        provisionalPayout: null,
        provisionalPnl: null,
      };
    }
    legSettlements.push({
      venue: leg.venue,
      side,
      winningOutcome: outcome,
      shares,
      payout: side === outcome ? shares : 0,
    });
  }
  const payout = legSettlements.reduce((sum, leg) => sum + leg.payout, 0);
  const entryCash = finiteNumber(trade.entryCash ?? trade.pairCash);
  if (entryCash === null) {
    return {
      ...base,
      status: "awaiting_official_venue_settlement",
      venueSettlements: normalizedSettlements,
      provisionalOutcome: null,
      provisionalPayout: null,
      provisionalPnl: null,
    };
  }
  const finalOutcome = [...requiredVenues]
    .map((key) => `${key === "polymarket" ? "Polymarket" : "Predict.fun"} ${normalizedSettlements[key].outcome}`)
    .join(" / ");
  return {
    ...base,
    status: "finalized_official_venue_settlement",
    finalized: true,
    finalOutcome,
    finalPayout: payout,
    realizedPnl: payout - entryCash,
    finalizedAt: Math.max(Number(nowMs), Number(trade.closeMs) || 0),
    settlementLabel: "INDEPENDENT_OFFICIAL_VENUE_SETTLEMENT",
    settlementMethod: "official_venue_markets",
    venueSettlements: normalizedSettlements,
    legSettlements,
    provisionalOutcome: null,
    provisionalPayout: null,
    provisionalPnl: null,
  };
}

function calculatePaperCapital(options = {}) {
  const startingCapitalUsd = Math.max(
    0,
    finiteNumber(options.startingCapitalUsd) ?? 0,
  );
  const realizedPnlUsd = finiteNumber(options.realizedPnlUsd) ?? 0;
  const trades = Array.isArray(options.trades) ? options.trades : [];
  const openTrades = trades.filter((trade) => trade && trade.finalized !== true);
  const capitalCommittedUsd = openTrades.reduce(
    (sum, trade) => sum + (finiteNumber(trade.entryCash ?? trade.pairCash) ?? 0),
    0,
  );
  const provisionalPnlUsd = openTrades.reduce(
    (sum, trade) => sum + (finiteNumber(trade.provisionalPnl) ?? 0),
    0,
  );
  const cashBalanceUsd = startingCapitalUsd + realizedPnlUsd;
  return {
    startingCapitalUsd,
    realizedPnlUsd,
    cashBalanceUsd,
    capitalCommittedUsd,
    availableCapitalUsd: cashBalanceUsd - capitalCommittedUsd,
    provisionalPnlUsd,
    paperEquityUsd: cashBalanceUsd + provisionalPnlUsd,
  };
}

module.exports = {
  FIVE_MINUTES_MS,
  DEFAULT_MAX_BOOK_AGE_MS,
  finiteNumber,
  toTimestampMs,
  windowForTime,
  windowsMatch,
  normalizeLevels,
  complementPrice,
  complementYesBook,
  polymarketTakerFee,
  predictTakerFee,
  walkAsks,
  walkBids,
  checkBookFresh,
  evaluateLaggingVenueEntry,
  mapPredictUpDownOutcomes,
  getExplicitMarketWindow,
  evaluatePredictMarketMatch,
  benchmarkOutcome,
  getPolymarketResolvedOutcome,
  getPredictResolvedOutcome,
  pairPayoutForOutcome,
  updateTradeWithOfficialVenueSettlement,
  calculatePaperCapital,
};
