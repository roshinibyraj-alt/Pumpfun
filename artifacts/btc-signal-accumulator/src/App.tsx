import { useCallback, useEffect, useState } from "react";

type Level = { price: number; size: number };
type Quote = {
  status?: string;
  error?: string | null;
  observedAt?: number | null;
  receivedAt?: number | null;
  timestampKind?: "source" | "received";
  ageMs?: number | null;
  requestLatencyMs?: number | null;
  bids?: Level[];
  asks?: Level[];
  bestBid?: Level | null;
  bestAsk?: Level | null;
  bidDepth?: number;
  askDepth?: number;
};
type Venue = {
  name: string;
  status: string;
  error?: string | null;
  market?: {
    id?: string | null;
    title?: string | null;
    question?: string | null;
    slug?: string | null;
    conditionId?: string | null;
    startMs?: number | null;
    closeMs?: number | null;
    outcomes?: string[];
    matchStatus?: string;
    matchMethod?: string | null;
    matchReason?: string | null;
    marketVariant?: string | null;
    tradingStatus?: string | null;
    variantData?: {
      type?: string | null;
      priceFeedProvider?: string | null;
      priceFeedSymbol?: string | null;
    };
    externalSettlement?: string | null;
    resolutionSource?: string | null;
    description?: string | null;
  };
  marketCandidates?: Array<{
    id?: string | null;
    title?: string | null;
    slug?: string | null;
    startMs?: number | null;
    closeMs?: number | null;
    matchStatus?: string;
    matchReason?: string | null;
  }>;
  candidateCount?: number;
  up?: Quote;
  down?: Quote;
};
type Opportunity = {
  direction: string;
  side?: "UP" | "DOWN";
  entryVenue?: string;
  referenceVenue?: string;
  status: string;
  eligible: boolean;
  triggerMet?: boolean;
  alreadyFiredThisWindow?: boolean;
  pendingExecution?: boolean;
  simulatedArrivalAt?: number | null;
  reason: string;
  shares?: number;
  entryCash?: number;
  entryAsk?: number;
  referenceBid?: number;
  referenceBidThreshold?: number;
  minimumEntryAsk?: number;
  maximumEntryAsk?: number;
  elapsedSeconds?: number;
  entryAveragePrice?: number;
  entryCount?: number;
  reentriesRemaining?: number;
  openPosition?: boolean;
  legs?: Array<{
    venue: string;
    side: string;
    shares: number;
    averagePrice: number;
    fees: number;
    cash: number;
    depthSlippagePerShare: number | null;
  }>;
};
type PaperTrade = {
  id: string;
  openedAt: number;
  closeMs: number;
  direction: string;
  side?: string;
  venue?: string;
  entryNumber?: number;
  shares: number;
  entryCash?: number;
  entryAveragePrice?: number;
  pairCash?: number;
  fees: number;
  exitReason?: string;
  exitPrice?: number;
  exitFees?: number;
  stopBid?: number;
  settlementMethod?: string | null;
  status: string;
  finalized: boolean;
  finalOutcome?: string;
  finalPayout?: number;
  realizedPnl?: number;
  provisionalOutcome?: string | null;
  provisionalPnl?: number | null;
  venueSettlements?: {
    polymarket?: { status?: string; outcome?: string | null; reason?: string | null };
    predict?: { status?: string; outcome?: string | null; reason?: string | null };
  } | null;
  simulatedLatencyMs?: number | null;
  executionPriceDriftPerShare?: number | null;
  legs: Array<{ venue: string; side: string; averagePrice: number; cash: number }>;
};
type BotState = {
  app: string;
  mode: string;
  running: boolean;
  now: number;
  pollMs: number;
  polling?: {
    targetIntervalMs?: number;
    lastCycleMs?: number;
    rateLimitBackoffMs?: number;
  };
  lastError?: string | null;
  config?: {
    startingPaperCapitalUsd: number;
    maxBookAgeMs: number;
    maxBookSkewMs?: number;
    paperBaseLatencyMs?: number;
    executionModel?: string;
    strategy?: {
      referenceBidThreshold: number;
      minimumEntryAsk: number;
      maximumEntryAsk: number;
      shares: number;
      hardStopBid: number;
      takeProfitBid: number;
      takeProfitCreditPerShare: number;
      maxEntrySeconds: number;
      maxReentriesPerSidePerWindow: number;
    };
  };
  window?: { slug: string; openMs: number; closeMs: number; secondsRemaining: number };
  benchmark?: {
    source: string;
    use: string;
    status: string;
    openPrice?: number | null;
    currentPrice?: number | null;
    currentOutcome?: string | null;
    finalClosePrice?: number | null;
    finalOutcome?: string | null;
    error?: string;
    warning?: string;
    settlementRule?: string;
  };
  venues?: { polymarket: Venue; predict: Venue };
  opportunities?: Opportunity[];
  paperTrades?: PaperTrade[];
  stats?: {
    positionCount?: number;
    pairCount?: number;
    settledCount: number;
    wins: number;
    losses: number;
    realizedPnl: number;
    provisionalPnl: number;
    capitalCommitted: number;
    startingCapitalUsd: number;
    cashBalanceUsd: number;
    availableCapitalUsd: number;
    paperEquityUsd: number;
    feesPaid: number;
  };
  events?: Array<{ ts: number; event: string; note: string }>;
};

function dollars(value?: number | null, digits = 2) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : `$${Number(value).toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;
}

function shares(value?: number | null) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function clock(value?: number | null) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-AU", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) + " UTC";
}

function dateRange(start?: number | null, end?: number | null) {
  if (!start || !end) return "Window boundaries unavailable";
  return `${clock(start)} – ${clock(end)}`;
}

function ageLabel(quote?: Quote) {
  if (!quote?.observedAt) return "No timestamp";
  const age = Math.max(0, quote.ageMs ?? Date.now() - quote.observedAt);
  const label = quote.timestampKind === "source" ? "source" : "received";
  return age < 1000 ? `${label} just now` : `${label} ${(age / 1000).toFixed(1)}s ago`;
}

function statusLabel(status?: string) {
  if (!status) return "Waiting";
  return status.replaceAll("_", " ");
}

function opportunityView(
  item: Opportunity,
  strategy?: NonNullable<BotState["config"]>["strategy"],
) {
  const referenceThreshold = Number(
    item.referenceBidThreshold ?? strategy?.referenceBidThreshold ?? 0.8,
  );
  const minimumAsk = Number(item.minimumEntryAsk ?? strategy?.minimumEntryAsk ?? 0.6);
  const maximumAsk = Number(item.maximumEntryAsk ?? strategy?.maximumEntryAsk ?? 0.7);
  const hasBid = item.referenceBid != null && Number.isFinite(Number(item.referenceBid));
  const hasAsk = item.entryAsk != null && Number.isFinite(Number(item.entryAsk));
  const leaderPass = hasBid && Number(item.referenceBid) + 1e-9 >= referenceThreshold;
  const askPass =
    hasAsk &&
    Number(item.entryAsk) + 1e-9 >= minimumAsk &&
    Number(item.entryAsk) < maximumAsk - 1e-9;

  let label = "Waiting";
  let tone = "quiet";
  let reason = item.reason;
  if (item.pendingExecution) {
    label = "Latency recheck";
    tone = "warn";
    reason = "Price and depth qualified; both books are being checked again after modeled latency.";
  } else if (item.eligible) {
    label = `Ready · entry ${Number(item.entryCount || 0) + 1}/2`;
    tone = "good";
    reason = "All entry gates pass; the paper entry is ready to queue.";
  } else if (item.openPosition) {
    label = "Position open";
    tone = "warn";
    reason = "A position on this outcome is already open; the strategy will not add another until it exits.";
  } else if (item.entryCount && Number(item.reentriesRemaining || 0) === 0) {
    label = "Re-entry used";
    tone = "quiet";
    reason = "The one re-entry allowed for this side and window has already been used.";
  } else if (item.status === "below_threshold") {
    label = "Waiting on price";
    tone = "quiet";
    const unmet = [];
    if (!leaderPass) {
      unmet.push(
        hasBid
          ? `Leader bid ${dollars(item.referenceBid)} is below ${dollars(referenceThreshold)}.`
          : "Leader best bid is unavailable.",
      );
    }
    if (!askPass) {
      unmet.push(
        !hasAsk
          ? "Entry best ask is unavailable."
          : Number(item.entryAsk) < minimumAsk
            ? `Entry ask ${dollars(item.entryAsk)} is below ${dollars(minimumAsk)}.`
            : `Entry ask ${dollars(item.entryAsk)} must be below the ${dollars(maximumAsk)} cap.`,
      );
    }
    reason = unmet.join(" ");
  } else if (item.status === "insufficient_depth") {
    label = "Depth short";
    tone = "warn";
    reason = `Fewer than ${shares(strategy?.shares ?? 500)} shares are available below ${dollars(maximumAsk)}.`;
  } else if (item.status === "insufficient_capital") {
    label = "Capital short";
    tone = "warn";
  } else if (item.status === "cutoff") {
    label = "Entry cutoff";
    tone = "quiet";
  } else if (item.status === "blocked") {
    label = "Feed / match blocked";
    tone = "bad";
  }

  return {
    label,
    tone,
    reason,
    referenceThreshold,
    minimumAsk,
    maximumAsk,
    leaderPass,
    askPass,
    hasBid,
    hasAsk,
  };
}

function QuoteTile({ label, quote }: { label: string; quote?: Quote }) {
  const quoteStatus = quote?.status || "missing";
  const tone =
    quoteStatus === "ok"
      ? "good"
      : quoteStatus === "stale"
        ? "warn"
        : "quiet";
  return (
    <section className={`quote-tile ${label.toLowerCase()} ${tone}`}>
      <div className="quote-tile-head">
        <strong>{label}</strong>
        <span className={`tiny-status ${tone}`}>{statusLabel(quoteStatus)}</span>
      </div>
      <div className="quote-values">
        <div>
          <span className="quote-label">Best bid</span>
          <strong>{dollars(quote?.bestBid?.price)}</strong>
          <small>{quote?.bestBid ? `${shares(quote.bestBid.size)} sh` : "—"}</small>
        </div>
        <div>
          <span className="quote-label">Best ask</span>
          <strong>{dollars(quote?.bestAsk?.price)}</strong>
          <small>{quote?.bestAsk ? `${shares(quote.bestAsk.size)} sh` : "—"}</small>
        </div>
      </div>
      <div className="quote-footer">
        <span>Visible depth: {shares(quote?.askDepth)} ask / {shares(quote?.bidDepth)} bid</span>
        <span>
          {ageLabel(quote)}
          {quote?.requestLatencyMs != null ? ` · read ${Math.round(quote.requestLatencyMs)} ms` : ""}
        </span>
      </div>
      {quote?.error && <div className="inline-error">{quote.error}</div>}
    </section>
  );
}

function VenueCard({ venue }: { venue: Venue }) {
  const market = venue.market || {};
  const matchOk = market.matchStatus === "matched";
  const stateTone =
    venue.status === "connected" ? "good" : venue.status === "error" ? "bad" : "warn";
  return (
    <article className={`panel venue-panel ${venue.name === "Predict.fun" ? "venue-predict" : "venue-poly"}`}>
      <div className="panel-heading">
        <div>
          <div className="eyebrow">VENUE</div>
          <h2>{venue.name}</h2>
        </div>
        <span className={`status-pill ${stateTone}`}>{statusLabel(venue.status)}</span>
      </div>
      <div className="market-meta">
        <div className="market-title">{market.title || market.question || "No matched market yet"}</div>
        <div className="meta-row">
          <span>{dateRange(market.startMs, market.closeMs)}</span>
          <span className={`match-pill ${matchOk ? "good" : "warn"}`}>
            {matchOk ? "Window matched" : "Not matched"}
          </span>
        </div>
        {!matchOk && market.matchReason && <p className="match-reason">{market.matchReason}</p>}
        {!matchOk && (venue.up?.status === "ok" || venue.down?.status === "ok") && (
          <p className="match-reason">
            These are live quotes for the named market only. No signal can fire until both exact
            five-minute windows are matched.
          </p>
        )}
        <details className="market-details">
          <summary>Market &amp; settlement details</summary>
          <div className="meta-row subtle">
            <span>Outcomes: {market.outcomes?.join(" / ") || "not available"}</span>
            <span>Condition: {market.conditionId || market.id || "—"}</span>
          </div>
          {market.matchReason && matchOk && <p className="match-reason">{market.matchReason}</p>}
          {market.resolutionSource && (
            <p className="match-reason">Venue resolution source: {market.resolutionSource}</p>
          )}
          {market.externalSettlement && (
            <p className="match-reason">Venue oracle metadata: {market.externalSettlement}</p>
          )}
        </details>
      </div>
      <div className="quote-grid">
        <QuoteTile label="UP" quote={venue.up} />
        <QuoteTile label="DOWN" quote={venue.down} />
      </div>
      {venue.name === "Predict.fun" && (venue.candidateCount || 0) > 0 && (
        <details className="market-candidates">
          <summary>Open Predict markets checked ({venue.candidateCount})</summary>
          <ul>
            {(venue.marketCandidates || []).map((candidate, index) => (
              <li key={`${candidate.id || candidate.slug || candidate.title || "market"}-${index}`}>
                <strong>{candidate.title || candidate.slug || candidate.id || "Untitled market"}</strong>
                <span>{candidate.matchStatus === "matched" ? "Exact window match" : "Not an exact window match"}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {venue.error && <div className="inline-error venue-error">{venue.error}</div>}
    </article>
  );
}

function App() {
  const [state, setState] = useState<BotState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/bot/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`Dashboard API returned HTTP ${response.status}`);
      const data = (await response.json()) as BotState;
      setState(data);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load bot state.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (active) timer = window.setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);

  const controlBot = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      const response = await fetch(`/api/bot/${action}`, { method: "POST" });
      if (!response.ok) throw new Error(`Could not ${action} the paper scanner.`);
      await refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Bot control failed.");
    } finally {
      setBusy(false);
    }
  };

  const config = state?.config;
  const polling = state?.polling;
  const benchmark = state?.benchmark;
  const stats = state?.stats;
  const trades = state?.paperTrades || [];
  const opportunities = state?.opportunities || [];
  const readyCount = opportunities.filter((item) => item.eligible).length;
  const priceQualifiedCount = opportunities.filter((item) => item.triggerMet).length;
  const pnl = stats?.realizedPnl ?? 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BTC cross-venue paper signal dashboard">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>
            <strong>LAG / SIGNAL</strong>
            <small>BTC 5-minute cross-venue</small>
          </span>
        </a>
        <div className="topbar-right">
          <span className="paper-badge"><span className="pulse-dot" /> PAPER ONLY</span>
          <span className={`running-badge ${state?.running ? "active" : ""}`}>
            {state?.running ? "Scanner running" : "Scanner stopped"}
          </span>
          <button
            className={state?.running ? "control-button stop" : "control-button start"}
            disabled={busy}
            onClick={() => void controlBot(state?.running ? "stop" : "start")}
          >
            {busy ? "Working…" : state?.running ? "Stop scanner" : "Start scanner"}
          </button>
        </div>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">CROSS-VENUE PAPER SCANNER</div>
          <h1>BTC Cross-Venue Lag Signal</h1>
          <p>
            Paper-only execution across the same outcome in both matched five-minute markets.
          </p>
        </div>
        <div className="window-clock">
          <span className="eyebrow">CURRENT UTC WINDOW</span>
          <strong>{state?.window ? dateRange(state.window.openMs, state.window.closeMs) : "Waiting for feed"}</strong>
          <small>
            {state?.window
              ? `${Math.ceil(state.window.secondsRemaining)} seconds remaining · ${state.window.slug}`
              : "—"}
          </small>
        </div>
      </section>

      {(loadError || state?.lastError) && (
        <div className="alert alert-error">{loadError || state?.lastError}</div>
      )}

      <section className="stat-grid">
        <article className="stat-card stat-capital">
          <span className="stat-label">Available demo capital</span>
          <strong className={`stat-value ${(stats?.availableCapitalUsd ?? 0) >= 0 ? "" : "negative"}`}>
            {dollars(stats?.availableCapitalUsd)}
          </strong>
          <span className="stat-foot">
            {dollars(stats?.startingCapitalUsd ?? config?.startingPaperCapitalUsd)} starting ·{" "}
            {dollars(stats?.capitalCommitted)} committed
          </span>
        </article>
        <article className="stat-card stat-edge">
          <span className="stat-label">Entry conditions</span>
          <strong className="stat-value accent">
            ≥{dollars(config?.strategy?.referenceBidThreshold, 2)} <small>leader bid</small>
          </strong>
          <span className="stat-foot">
            Buy ask {dollars(config?.strategy?.minimumEntryAsk, 2)}–&lt;{dollars(config?.strategy?.maximumEntryAsk, 2)}
          </span>
        </article>
        <article className="stat-card stat-leg">
          <span className="stat-label">Paper entry size</span>
          <strong className="stat-value">{shares(config?.strategy?.shares)} <small>shares</small></strong>
          <span className="stat-foot">
            TP {dollars(config?.strategy?.takeProfitBid, 2)} → {dollars(config?.strategy?.takeProfitCreditPerShare, 2)}/share
          </span>
        </article>
        <article className="stat-card stat-ready">
          <span className="stat-label">Stop / entry cutoff</span>
          <strong className="stat-value">
            ≤{dollars(config?.strategy?.hardStopBid, 2)} best bid / {config?.strategy?.maxEntrySeconds ?? 270}s
          </strong>
          <span className="stat-foot">
            {readyCount} ready · {opportunities.filter((item) => item.pendingExecution).length} pending · one re-entry/side
          </span>
        </article>
        <article className="stat-card stat-pnl">
          <span className="stat-label">Realized model P&amp;L</span>
          <strong className={`stat-value ${pnl >= 0 ? "positive" : "negative"}`}>{dollars(pnl)}</strong>
          <span className="stat-foot">{stats?.wins || 0} model wins · {stats?.losses || 0} model losses</span>
        </article>
      </section>

      <section className="section-heading">
        <div>
          <div className="eyebrow">LIVE MARKET DATA</div>
          <h2>Each venue, each outcome</h2>
        </div>
        <div className="heading-tools">
          <div className="outcome-legend" aria-label="Outcome color key">
            <span className="legend-up"><i /> UP</span>
            <span className="legend-down"><i /> DOWN</span>
          </div>
          <span className="refresh-indicator">
            <span className="pulse-dot" />
            {polling?.rateLimitBackoffMs
              ? `rate-limit pause · ${Math.round(polling.rateLimitBackoffMs / 1000)}s`
              : `${polling?.targetIntervalMs ?? state?.pollMs ?? 500}ms target · last cycle ${polling?.lastCycleMs ?? 0}ms`}
          </span>
        </div>
      </section>
      <section className="venue-grid">
        <VenueCard venue={state?.venues?.polymarket || { name: "Polymarket", status: "waiting" }} />
        <VenueCard venue={state?.venues?.predict || { name: "Predict.fun", status: "waiting" }} />
      </section>

      {state?.venues?.predict?.status === "needs_api_key" && (
        <section className="alert alert-key">
          <div>
            <strong>Predict.fun data needs a server-side API key.</strong>
            <span>
              Add <code>PREDICT_API_KEY</code> to the Railway service’s Variables. The key stays
              on the server and is never sent to this dashboard.
            </span>
          </div>
        </section>
      )}

      <section className="section-heading">
        <div>
          <div className="eyebrow">ENTRY GATES</div>
          <h2>Why an entry is ready or blocked</h2>
        </div>
        <span className="subtle">{readyCount} ready · {priceQualifiedCount} price-qualified</span>
      </section>
      <section className="signal-board">
        {opportunities.map((item) => {
          const view = opportunityView(item, config?.strategy);
          const priceTone = (hasPrice: boolean, passes: boolean) =>
            hasPrice ? (passes ? "pass" : "fail") : "unknown";
          return (
            <article className="panel signal-card" key={item.direction}>
              <div className="signal-card-head">
                <div className="signal-route">
                  <span className={`outcome-mark ${item.side?.toLowerCase() || ""}`}>
                    {item.side || "—"}
                  </span>
                  <div>
                    <strong>{item.entryVenue || "—"}</strong>
                    <small>Entry venue · {item.referenceVenue || "—"} leads</small>
                  </div>
                </div>
                <span className={`status-pill ${view.tone}`}>{view.label}</span>
              </div>
              <div className="signal-gates">
                <div className={`signal-gate ${priceTone(view.hasBid, view.leaderPass)}`}>
                  <span>Leader best bid</span>
                  <strong>
                    {dollars(item.referenceBid)}
                    <small> / ≥ {dollars(view.referenceThreshold)}</small>
                  </strong>
                  <em>{view.hasBid ? (view.leaderPass ? "PASS" : "BELOW") : "NO DATA"}</em>
                </div>
                <div className={`signal-gate ${priceTone(view.hasAsk, view.askPass)}`}>
                  <span>Lagging best ask</span>
                  <strong>
                    {dollars(item.entryAsk)}
                    <small> / {dollars(view.minimumAsk)}–&lt;{dollars(view.maximumAsk)}</small>
                  </strong>
                  <em>{view.hasAsk ? (view.askPass ? "PASS" : "OUTSIDE BAND") : "NO DATA"}</em>
                </div>
                <div className="signal-gate signal-size">
                  <span>500-share entry</span>
                  <strong>{item.entryCash != null ? dollars(item.entryCash) : "—"}</strong>
                  <em>
                    {item.entryCash != null
                      ? "ESTIMATED CASH"
                      : item.status === "insufficient_depth"
                        ? "DEPTH SHORT"
                        : "DEPTH CHECK AFTER PRICE"}
                  </em>
                </div>
              </div>
              <p className={`signal-reason ${view.tone}`}>
                <strong>Why:</strong> {view.reason}
              </p>
            </article>
          );
        })}
        {!opportunities.length && (
          <div className="panel empty-state">Waiting for both venue books…</div>
        )}
      </section>

      <section className="panel trades-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">PAPER POSITIONS</div>
              <h2>Recent entries and exits</h2>
            </div>
            <span className="subtle">{stats?.positionCount ?? stats?.pairCount ?? 0} total · {dollars(stats?.capitalCommitted || 0)} open</span>
          </div>
          <div className="trade-list">
            {trades.slice(0, 8).map((trade) => {
              const value = trade.finalized ? trade.realizedPnl : trade.provisionalPnl;
              const settlementTone = !trade.finalized
                ? trade.status?.includes("awaiting")
                  ? "warn"
                  : "quiet"
                : Number(trade.realizedPnl) >= 0
                  ? "good"
                  : "bad";
              const venueResults = trade.venueSettlements;
              return (
                <div className="trade-row" key={trade.id}>
                  <div className="trade-main">
                    <strong>{trade.direction}</strong>
                    <small>
                      {trade.venue ? `${trade.venue} ${trade.side || ""} · ` : ""}
                      {shares(trade.shares)} shares · {dollars(trade.entryCash ?? trade.pairCash)} entry
                      {trade.stopBid != null ? ` · stop at ${dollars(trade.stopBid, 2)}` : ""}
                      {trade.entryNumber ? ` · entry ${trade.entryNumber}/2` : ""}
                      {trade.simulatedLatencyMs != null
                        ? ` · ${Math.round(trade.simulatedLatencyMs)}ms modeled delay`
                        : ""}
                      {trade.executionPriceDriftPerShare != null
                        ? ` · cost drift ${trade.executionPriceDriftPerShare >= 0 ? "+" : ""}${dollars(trade.executionPriceDriftPerShare, 4)}/sh`
                        : ""}
                      {venueResults
                        ? ` · Results: Poly ${venueResults.polymarket?.outcome || statusLabel(venueResults.polymarket?.status)}, Predict ${venueResults.predict?.outcome || statusLabel(venueResults.predict?.status)}`
                        : ""}
                    </small>
                  </div>
                  <div className="trade-result">
                    <span className={`status-pill ${settlementTone}`}>
                      {trade.settlementMethod === "simulated_take_profit"
                        ? "TP · $1/share"
                        : trade.settlementMethod === "simulated_stop_loss"
                          ? "Hard stop"
                          : trade.finalized
                            ? "Venue settled"
                            : statusLabel(trade.status)}
                    </span>
                    <strong className={value == null ? "muted" : value >= 0 ? "positive" : "negative"}>
                      {value == null ? "—" : dollars(value)}
                    </strong>
                  </div>
                </div>
              );
            })}
            {!trades.length && <div className="empty-state">No paper positions have fired yet.</div>}
          </div>
      </section>

      <details className="diagnostic-disclosure">
        <summary>Settlement and diagnostic feed details</summary>
        <div className="lower-grid">
          <article className="panel benchmark-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">DIAGNOSTIC ONLY</div>
                <h2>Coinbase reference feed</h2>
              </div>
              <span className="status-pill quiet">{statusLabel(benchmark?.status)}</span>
            </div>
            <div className="benchmark-source">{benchmark?.source || "Coinbase Exchange BTC-USD"}</div>
            <div className="benchmark-grid">
              <div><span>Window open</span><strong>{dollars(benchmark?.openPrice, 2)}</strong></div>
              <div><span>Current spot</span><strong>{dollars(benchmark?.currentPrice, 2)}</strong></div>
              <div><span>Provisional</span><strong className={benchmark?.currentOutcome === "UP" ? "positive" : benchmark?.currentOutcome === "DOWN" ? "negative" : ""}>{benchmark?.currentOutcome || "—"}</strong></div>
              <div><span>Final close</span><strong>{dollars(benchmark?.finalClosePrice, 2)}</strong></div>
            </div>
            <p className="warning-text">
              {benchmark?.warning || "Internal benchmark only—not either venue’s official resolution or actual token payout."}
            </p>
            {benchmark?.error && <p className="inline-error">{benchmark.error}</p>}
            <p className="settlement-rule">{benchmark?.settlementRule}</p>
          </article>
          <article className="panel settlement-note">
            <div className="eyebrow">PAPER MODEL LIMITS</div>
            <h2>Execution and settlement</h2>
            <p>
              Open positions wait for the exact venue holding those shares to publish its own
              resolved outcome. Take-profit and stop exits use delayed snapshots, visible depth,
              and venue fees. The Coinbase reference is diagnostic only and never triggers or
              settles a position.
            </p>
            <p>
              This is a simulation; it cannot represent queue priority, hidden liquidity, actual
              order acknowledgements, or real partial-fill risk.
            </p>
          </article>
        </div>
      </details>

      <footer className="footer">
        <span>LAG / SIGNAL · DEMO ONLY</span>
        <span>Read-only market data · no signing · no order endpoints</span>
      </footer>
    </main>
  );
}

export default App;
