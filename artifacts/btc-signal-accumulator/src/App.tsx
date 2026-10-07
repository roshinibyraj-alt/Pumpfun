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
  status: string;
  eligible: boolean;
  alreadyFiredThisWindow?: boolean;
  pendingExecution?: boolean;
  simulatedArrivalAt?: number | null;
  reason: string;
  shares?: number;
  pairCash?: number;
  pairCostPerShare?: number;
  grossEdgePerShare?: number;
  netEdgePerShare?: number;
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
  shares: number;
  pairCash: number;
  fees: number;
  netEdgePerShare: number;
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
    maxCashPerLegUsd: number;
    maxCashPerOpportunityUsd: number;
    minNetEdgePerShare: number;
    safetyMarginPerShare: number;
    maxBookAgeMs: number;
    maxBookSkewMs?: number;
    paperBaseLatencyMs?: number;
    executionModel?: string;
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
    pairCount: number;
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

function QuoteTile({ label, quote }: { label: string; quote?: Quote }) {
  const quoteStatus = quote?.status || "missing";
  const tone =
    quoteStatus === "ok"
      ? "good"
      : quoteStatus === "stale"
        ? "warn"
        : "quiet";
  return (
    <section className={`quote-tile ${tone}`}>
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
    <article className="panel venue-panel">
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
        <div className="meta-row subtle">
          <span>Outcomes: {market.outcomes?.join(" / ") || "not available"}</span>
          <span>Condition: {market.conditionId || market.id || "—"}</span>
        </div>
        {market.matchReason && <p className="match-reason">{market.matchReason}</p>}
        {!matchOk && (venue.up?.status === "ok" || venue.down?.status === "ok") && (
          <p className="match-reason">
            These are live quotes for the named market only. They are not used by the pair scanner
            until its 5-minute window is exactly matched.
          </p>
        )}
        {market.resolutionSource && (
          <p className="match-reason">Venue resolution source: {market.resolutionSource}</p>
        )}
        {market.externalSettlement && (
          <p className="match-reason">Venue oracle metadata: {market.externalSettlement}</p>
        )}
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
  const pnl = stats?.realizedPnl ?? 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="BTC cross-venue paper arbitrage dashboard">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>
            <strong>PAIR / SIGNAL</strong>
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
          <h1>BTC Up / Down Arb</h1>
          <p>
            Compares executable UP and DOWN asks on Polymarket and Predict.fun.
            It sends no orders and uses no wallet.
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

      <section className="notice-strip">
        <div className="notice-icon">i</div>
        <div>
          <strong>Signals use venue books only.</strong>
          <span>
            Arb detection compares the four UP/DOWN order books, executable depth, taker fees,
            and the $0.10 net-edge threshold. A paper fill waits for modeled latency, then rechecks
            the new prices and depth; BTC reference prices never trigger a signal.
          </span>
        </div>
      </section>

      <section className="stat-grid">
        <article className="stat-card">
          <span className="stat-label">Available demo capital</span>
          <strong className={`stat-value ${(stats?.availableCapitalUsd ?? 0) >= 0 ? "" : "negative"}`}>
            {dollars(stats?.availableCapitalUsd)}
          </strong>
          <span className="stat-foot">
            {dollars(stats?.startingCapitalUsd ?? config?.startingPaperCapitalUsd)} starting ·{" "}
            {dollars(stats?.capitalCommitted)} committed
          </span>
        </article>
        <article className="stat-card">
          <span className="stat-label">Minimum net edge</span>
          <strong className="stat-value accent">{dollars(config?.minNetEdgePerShare, 2)} <small>/ share</small></strong>
          <span className="stat-foot">after fees + {dollars(config?.safetyMarginPerShare)} safety margin</span>
        </article>
        <article className="stat-card">
          <span className="stat-label">Paper cap per leg</span>
          <strong className="stat-value">{dollars(config?.maxCashPerLegUsd)}</strong>
          <span className="stat-foot">
            up to {dollars(config?.maxCashPerOpportunityUsd)} per pair · {config?.paperBaseLatencyMs ?? 500}ms base delay
          </span>
        </article>
        <article className="stat-card">
          <span className="stat-label">Ready / pending</span>
          <strong className={`stat-value ${readyCount ? "positive" : ""}`}>
            {readyCount} / {opportunities.filter((item) => item.pendingExecution).length}
          </strong>
          <span className="stat-foot">one paper pair per direction / window</span>
        </article>
        <article className="stat-card">
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
        <span className="refresh-indicator">
          <span className="pulse-dot" />
          {polling?.rateLimitBackoffMs
            ? `rate-limit pause · ${Math.round(polling.rateLimitBackoffMs / 1000)}s`
            : `${polling?.targetIntervalMs ?? state?.pollMs ?? 500}ms target · last cycle ${polling?.lastCycleMs ?? 0}ms`}
        </span>
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
          <div className="eyebrow">PAPER SIGNAL MODEL</div>
          <h2>Both arbitrage directions</h2>
        </div>
        <span className="subtle">Matched shares · depth-aware fees · no live orders</span>
      </section>
      <section className="panel table-panel">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Pair direction</th>
                <th>Equal shares</th>
                <th>All-in pair cost</th>
                <th>Net edge / share</th>
                <th>Model state</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((item) => {
                const wasFired = item.alreadyFiredThisWindow;
                const pending = item.pendingExecution;
                const good = item.status === "trigger" || item.eligible;
                const legSummary = item.legs
                  ?.map(
                    (leg) =>
                      `${leg.venue} ${leg.side}: avg ${dollars(leg.averagePrice, 4)}, fee ${dollars(leg.fees, 4)}, depth slip +${dollars(leg.depthSlippagePerShare, 4)}/sh`,
                  )
                  .join(" · ");
                return (
                  <tr key={item.direction}>
                    <td>
                      <strong>{item.direction}</strong>
                      <small className="table-note">
                        {legSummary ? `${legSummary} · ` : ""}{item.reason}
                      </small>
                    </td>
                    <td>{item.shares ? `${shares(item.shares)} sh` : "—"}</td>
                    <td>{item.pairCash != null ? dollars(item.pairCash) : "—"}</td>
                    <td className={good ? "positive" : "muted"}>
                      {item.netEdgePerShare != null ? `${dollars(item.netEdgePerShare, 4)} / sh` : "—"}
                    </td>
                    <td>
                      <span className={`status-pill ${wasFired || good ? "good" : pending || item.status === "blocked" ? "warn" : "quiet"}`}>
                        {wasFired ? "Already fired" : pending ? "Latency recheck" : good ? "Ready to paper" : statusLabel(item.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!opportunities.length && (
                <tr><td colSpan={5} className="empty-cell">Waiting for market data…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="lower-grid">
        <article className="panel benchmark-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">DIAGNOSTIC ONLY</div>
              <h2>Coinbase reference feed</h2>
            </div>
            <span className="status-pill quiet">
              {statusLabel(benchmark?.status)}
            </span>
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

        <article className="panel trades-panel">
          <div className="panel-heading">
            <div>
              <div className="eyebrow">SIMULATED POSITIONS</div>
              <h2>Recent paper pairs</h2>
            </div>
            <span className="subtle">{stats?.pairCount || 0} total · {dollars(stats?.capitalCommitted || 0)} open</span>
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
                      {shares(trade.shares)} equal shares · {dollars(trade.pairCash)} all-in
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
                      {trade.finalized ? "Venue settled" : statusLabel(trade.status)}
                    </span>
                    <strong className={value == null ? "muted" : value >= 0 ? "positive" : "negative"}>
                      {value == null ? "—" : dollars(value)}
                    </strong>
                  </div>
                </div>
              );
            })}
            {!trades.length && <div className="empty-state">No paper pairs have fired yet.</div>}
          </div>
        </article>
      </section>

      <section className="bottom-warning">
        <strong>Settlement warning:</strong> Final paper P&amp;L waits for the exact Polymarket and
        Predict.fun markets to publish their own resolved outcomes; the two venues may resolve
        differently, and both paper legs can lose. The Coinbase reference above is diagnostic only
        and never finalizes P&amp;L. Delayed paper
        fills walk visible asks after the latency check; the model cannot represent queue priority,
        hidden liquidity, real acknowledgements, or actual partial-fill risk.
      </section>

      <footer className="footer">
        <span>PAIR / SIGNAL · DEMO ONLY</span>
        <span>Read-only market data · no signing · no order endpoints</span>
      </footer>
    </main>
  );
}

export default App;
