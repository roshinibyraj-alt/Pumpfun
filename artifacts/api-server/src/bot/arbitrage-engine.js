"use strict";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BOOK_AGE_MS = 8000;
const CLOB_CLOSE_WINNER_THRESHOLD = 0.98;

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

function walkAsksForBudget(asks, budgetUsd, feeModel) {
  let remainingBudget = Number(budgetUsd);
  let shares = 0;
  let notional = 0;
  let fees = 0;
  let worstPrice = null;
  let levelsUsed = 0;
  const fills = [];
  if (!Number.isFinite(remainingBudget) || remainingBudget <= 0) return null;
  for (const level of normalizeLevels(asks, "asks")) {
    if (remainingBudget <= 1e-7) break;
    const feePerShare = feeForModel(feeModel, 1, level.price);
    const cashPerShare = level.price + feePerShare;
    let quantity = Math.min(level.size, remainingBudget / cashPerShare);
    quantity = Math.floor((quantity + 1e-10) * 1_000_000) / 1_000_000;
    if (quantity <= 0) continue;
    const levelNotional = quantity * level.price;
    const levelFees = feeForModel(feeModel, quantity, level.price);
    const levelCash = levelNotional + levelFees;
    if (levelCash > remainingBudget + 1e-7) continue;
    shares += quantity;
    notional += levelNotional;
    fees += levelFees;
    remainingBudget = Math.max(0, remainingBudget - levelCash);
    worstPrice = level.price;
    levelsUsed += 1;
    fills.push({ price: level.price, shares: quantity });
  }
  if (shares <= 0) return null;
  return {
    shares,
    notional,
    fees,
    cash: notional + fees,
    budgetUsd: Number(budgetUsd),
    unusedBudgetUsd: Math.max(0, Number(budgetUsd) - notional - fees),
    averagePrice: notional / shares,
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
  const stakeUsd = finiteNumber(options.stakeUsd);
  const fixedShares = finiteNumber(options.shares);
  const shares = stakeUsd === null ? Number(fixedShares ?? 500) : null;
  const referenceBidThreshold = Number(options.referenceBidThreshold ?? 0.7);
  const minimumEntryAsk = Number(options.minimumEntryAsk ?? 0.6);
  const maximumEntryAsk = Number(options.maximumEntryAsk ?? 0.7);
  const maxEntrySeconds = Number(options.maxEntrySeconds ?? 270);
  const maxBookAgeMs = Number(options.maxBookAgeMs ?? DEFAULT_MAX_BOOK_AGE_MS);
  const maxBookSkewMs = finiteNumber(options.maxBookSkewMs);
  const referenceBook = options.referenceBook;
  const entryBook = options.entryBook;
  const signalEntryBook = options.signalEntryBook || entryBook;
  const signalSide = String(options.signalSide || "UP").toUpperCase();
  const entrySide = String(options.entrySide || signalSide).toUpperCase();
  const blocked = (reason, extra = {}) => ({
    status: "blocked", eligible: false, triggerMet: false, signalObserved: false,
    reason, ...extra,
  });
  if ((stakeUsd === null && (!Number.isFinite(shares) || shares <= 0)) || (stakeUsd !== null && stakeUsd <= 0)) {
    return blocked("Paper stake or share quantity must be positive.");
  }
  if (options.referenceMarketMatched !== true || options.entryMarketMatched !== true) {
    return blocked(options.matchReason || "Both venue markets must be safely matched to the same window.");
  }
  const referenceFresh = checkBookFresh(referenceBook, nowMs, maxBookAgeMs);
  if (!referenceFresh.ok) return blocked("Reference venue book: " + referenceFresh.reason);
  const signalEntryFresh = checkBookFresh(signalEntryBook, nowMs, maxBookAgeMs);
  if (!signalEntryFresh.ok) return blocked("Entry venue book for signal side: " + signalEntryFresh.reason);
  const entryFresh = checkBookFresh(entryBook, nowMs, maxBookAgeMs);
  if (!entryFresh.ok) return blocked("Opposite-outcome entry venue book: " + entryFresh.reason);
  const snapshotTimes = [
    finiteNumber(referenceBook?.receivedAt ?? referenceBook?.observedAt),
    finiteNumber(signalEntryBook?.receivedAt ?? signalEntryBook?.observedAt),
    finiteNumber(entryBook?.receivedAt ?? entryBook?.observedAt),
  ];
  if (snapshotTimes.some(value => value === null)) return blocked("A venue book timestamp is missing.");
  const snapshotSkewMs = Math.max(...snapshotTimes) - Math.min(...snapshotTimes);
  if (maxBookSkewMs !== null && snapshotSkewMs > maxBookSkewMs) {
    return blocked("Venue book snapshots are " + Math.round(snapshotSkewMs) + " ms apart; the limit is " + Math.round(maxBookSkewMs) + " ms.", { snapshotSkewMs });
  }
  const referenceBid = normalizeLevels(referenceBook?.bids, "bids")[0]?.price ?? null;
  const signalEntryAsk = normalizeLevels(signalEntryBook?.asks, "asks")[0]?.price ?? null;
  const entryAsk = normalizeLevels(entryBook?.asks, "asks")[0]?.price ?? null;
  if (referenceBid === null) return blocked("Reference venue has no executable best bid.");
  if (signalEntryAsk === null) return blocked("Signal-side entry venue has no executable best ask.");
  if (entryAsk === null) return blocked("Opposite-outcome entry venue has no executable best ask.");
  const triggerMet = referenceBid + 1e-9 >= referenceBidThreshold && signalEntryAsk + 1e-9 >= minimumEntryAsk && signalEntryAsk < maximumEntryAsk - 1e-9;
  const observed = { referenceBid, entryAsk, signalEntryAsk, signalSide, entrySide, snapshotSkewMs, signalObserved: true, triggerMet, referenceBidThreshold, minimumEntryAsk, maximumEntryAsk };
  if (!triggerMet) {
    const unmetRules = [];
    if (referenceBid + 1e-9 < referenceBidThreshold) unmetRules.push("reference best bid >= $" + referenceBidThreshold.toFixed(2));
    if (signalEntryAsk + 1e-9 < minimumEntryAsk) unmetRules.push("same-signal outcome ask >= $" + minimumEntryAsk.toFixed(2));
    else if (signalEntryAsk >= maximumEntryAsk - 1e-9) unmetRules.push("same-signal outcome ask < $" + maximumEntryAsk.toFixed(2));
    return { status: "below_threshold", eligible: false, reason: "Waiting for " + unmetRules.join(" and ") + ".", ...observed };
  }
  const windowOpenMs = finiteNumber(options.windowOpenMs);
  if (windowOpenMs === null || nowMs < windowOpenMs) return { status: "blocked", eligible: false, reason: "The matching five-minute window has not started.", ...observed };
  const elapsedSeconds = (nowMs - windowOpenMs) / 1000;
  if (elapsedSeconds >= maxEntrySeconds) return { status: "cutoff", eligible: false, reason: "No new entries after " + maxEntrySeconds + " seconds of the window.", elapsedSeconds, ...observed };
  // The ask band confirms the original signal only. The purchased opposite outcome uses its actual visible asks without a price floor or cap.
  const executableAsks = normalizeLevels(entryBook?.asks, "asks");
  const fill = stakeUsd === null ? walkAsks(executableAsks, shares, options.feeModel) : walkAsksForBudget(executableAsks, stakeUsd, options.feeModel);
  const targetStakeUsd = stakeUsd ?? fill?.cash ?? null;
  if (!fill || (stakeUsd !== null && fill.cash + 0.01 < stakeUsd)) {
    return { status: "insufficient_depth", eligible: false, reason: stakeUsd === null ? "Fewer than " + shares + " opposite-outcome shares are executable from visible asks." : "Visible opposite-outcome ask depth cannot execute the full $" + stakeUsd.toFixed(2) + " stake.", elapsedSeconds, stakeUsd: targetStakeUsd, ...observed };
  }
  const availableCash = finiteNumber(options.availableCashUsd);
  if (availableCash !== null && (targetStakeUsd > availableCash + 1e-6 || fill.cash > availableCash + 1e-6)) {
    return { status: "insufficient_capital", eligible: false, reason: "The next $" + Number(targetStakeUsd).toFixed(2) + " paper stake exceeds available demo capital of $" + availableCash.toFixed(2) + ".", elapsedSeconds, shares: fill.shares, stakeUsd: targetStakeUsd, entryCash: fill.cash, ...observed };
  }
  const bestAsk = executableAsks[0]?.price ?? null;
  return {
    status: "trigger", eligible: true,
    reason: signalSide + " signal confirmed by a $" + referenceBid.toFixed(2) + " reference bid and a $" + signalEntryAsk.toFixed(2) + " same-signal ask; paper-buying the opposite " + entrySide + " outcome at its actual visible asks.",
    shares: fill.shares, stakeUsd: targetStakeUsd, baseStakeUsd: options.baseStakeUsd ?? null,
    martingaleLossStreak: options.martingaleLossStreak ?? null, martingaleMultiplier: options.martingaleMultiplier ?? null,
    entryCash: fill.cash, notional: fill.notional, fees: fill.fees, averagePrice: fill.averagePrice,
    bestAsk, worstFillPrice: fill.worstPrice,
    depthSlippagePerShare: bestAsk === null ? null : Math.max(0, fill.averagePrice - bestAsk),
    levelsUsed: fill.levelsUsed, fills: fill.fills, elapsedSeconds, ...observed,
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

function normalizeCloseQuote(quote, source) {
  if (!quote || typeof quote !== "object") return null;
  const rawBid = quote.bid ?? quote.price;
  const bid =
    rawBid === null || rawBid === undefined ? null : finiteNumber(rawBid);
  if (bid === null || bid < 0 || bid > 1) return null;
  const rawTimestamp = quote.observedAt ?? quote.receivedAt ?? quote.ts;
  const observedAt =
    rawTimestamp === null || rawTimestamp === undefined
      ? null
      : finiteNumber(rawTimestamp);
  return { bid, observedAt, source: quote.source || source };
}

function resolveClobCloseOutcome(venueSnapshots = {}) {
  const finalQuotes = venueSnapshots.finalThreeSeconds || {};
  const lastQuotes = venueSnapshots.lastInWindow || {};
  const chooseSideQuote = (side) =>
    normalizeCloseQuote(finalQuotes[side], "final_three_seconds") ||
    normalizeCloseQuote(lastQuotes[side], "last_in_window");
  const up = chooseSideQuote("UP");
  const down = chooseSideQuote("DOWN");
  let outcome = null;
  let source = "no_valid_quotes_conservative_loss";
  const aboveThreshold = (quote) =>
    quote && quote.bid > CLOB_CLOSE_WINNER_THRESHOLD;

  if (aboveThreshold(up) && !aboveThreshold(down)) {
    outcome = "UP";
    source = "up_bid_above_0_98";
  } else if (aboveThreshold(down) && !aboveThreshold(up)) {
    outcome = "DOWN";
    source = "down_bid_above_0_98";
  } else if (up && down && up.bid !== down.bid) {
    outcome = up.bid > down.bid ? "UP" : "DOWN";
    source = "higher_best_bid";
  } else if (up && !down) {
    source = "incomplete_close_book_conservative_loss";
  } else if (down && !up) {
    source = "incomplete_close_book_conservative_loss";
  } else if (up && down) {
    const upTimestamp = up.observedAt ?? Number.NEGATIVE_INFINITY;
    const downTimestamp = down.observedAt ?? Number.NEGATIVE_INFINITY;
    outcome = downTimestamp > upTimestamp ? "DOWN" : "UP";
    source =
      upTimestamp === downTimestamp
        ? "equal_bids_tie_break_up"
        : "equal_bids_freshest_quote";
  }

  return {
    outcome,
    source,
    threshold: CLOB_CLOSE_WINNER_THRESHOLD,
    upBid: up?.bid ?? null,
    downBid: down?.bid ?? null,
    upQuoteAt: up?.observedAt ?? null,
    downQuoteAt: down?.observedAt ?? null,
    upQuoteSource: up?.source ?? null,
    downQuoteSource: down?.source ?? null,
  };
}

function updateTradeWithClobClosePriceProxy(
  trade,
  closeQuotesByVenue = {},
  nowMs = Date.now(),
) {
  if (trade.finalized === true) return trade;
  const closeMs = finiteNumber(trade.closeMs);
  if (closeMs !== null && Number(nowMs) < closeMs) {
    return {
      ...trade,
      finalized: false,
      status: trade.status || "open_position",
    };
  }

  const tradeVenue = venueKey(trade.venue);
  const storedLegs = Array.isArray(trade.legs) ? trade.legs : [];
  const legs =
    storedLegs.length > 0
      ? storedLegs
      : tradeVenue && trade.side && trade.shares !== undefined
        ? [trade]
        : [];
  const requiredVenues = new Set(
    legs.map((leg) => venueKey(leg.venue)).filter(Boolean),
  );
  if (requiredVenues.size === 0 && tradeVenue) requiredVenues.add(tradeVenue);

  const venueSettlements = {};
  for (const key of requiredVenues) {
    const result = resolveClobCloseOutcome(closeQuotesByVenue[key] || {});
    venueSettlements[key] = {
      status: "paper_proxy",
      outcome: result.outcome,
      source: "venue CLOB close-price paper proxy",
      decisionRule: result.source,
      threshold: result.threshold,
      upBid: result.upBid,
      downBid: result.downBid,
      upQuoteAt: result.upQuoteAt,
      downQuoteAt: result.downQuoteAt,
      upQuoteSource: result.upQuoteSource,
      downQuoteSource: result.downQuoteSource,
    };
  }

  const legSettlements = legs.map((leg) => {
    const key = venueKey(leg.venue);
    const side = String(leg.side ?? "").toUpperCase();
    const rawShares = leg.shares;
    const shares =
      rawShares === null || rawShares === undefined
        ? null
        : finiteNumber(rawShares);
    const winningOutcome = venueSettlements[key]?.outcome ?? null;
    const validLeg =
      (side === "UP" || side === "DOWN") && shares !== null && shares >= 0;
    return {
      venue: leg.venue,
      side,
      winningOutcome,
      shares,
      payout: validLeg && side === winningOutcome ? shares : 0,
      settlementSource: venueSettlements[key]?.source || "missing_venue_deterministic_up",
    };
  });
  const finalPayout = legSettlements.reduce(
    (sum, leg) => sum + (finiteNumber(leg.payout) ?? 0),
    0,
  );
  const rawEntryCash = trade.entryCash ?? trade.pairCash;
  const entryCash =
    rawEntryCash === null || rawEntryCash === undefined
      ? 0
      : finiteNumber(rawEntryCash) ?? 0;
  const finalOutcome =
    [...requiredVenues]
      .map((key) => {
        const name = key === "polymarket" ? "Polymarket" : "Predict.fun";
        return `${name} ${venueSettlements[key].outcome || "no complete CLOB close book"}`;
      })
      .join(" / ") || "No mapped venue";

  return {
    ...trade,
    status: "finalized_clob_close_price_proxy",
    finalized: true,
    finalOutcome,
    finalPayout,
    realizedPnl: finalPayout - entryCash,
    finalizedAt: Math.max(Number(nowMs), closeMs ?? 0),
    settlementLabel: "CLOB_CLOSE_PRICE_PAPER_PROXY_NOT_OFFICIAL",
    settlementMethod: "clob_close_price_proxy",
    officialVenueSettlements:
      trade.officialVenueSettlements ?? trade.venueSettlements ?? null,
    venueSettlements,
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
  walkAsksForBudget,
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
  CLOB_CLOSE_WINNER_THRESHOLD,
  resolveClobCloseOutcome,
  updateTradeWithClobClosePriceProxy,
  calculatePaperCapital,
};
