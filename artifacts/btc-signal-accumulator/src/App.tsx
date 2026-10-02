import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowDownRight, ArrowUpRight, Bitcoin, Clock3, Gauge, Layers3, Radio, RefreshCw, ShieldCheck, Signal, Wallet, Waves } from 'lucide-react';
import { getGetBotStateQueryKey, useGetBotState, useHealthCheck, useStartBot, useStopBot } from '@workspace/api-client-react';
import type { BotState, Position, Trade, BotEvent } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const money = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const compact = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const time = (v?: number | null) => {
  if (!v) return '—';
  const d = new Date(v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const duration = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
};

function Home() {
  const queryClient = useQueryClient();
  const stateQuery = useGetBotState({ query: { queryKey: getGetBotStateQueryKey(), refetchInterval: 500 } });
  const healthQuery = useHealthCheck();
  const start = useStartBot({ mutation: { onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: getGetBotStateQueryKey() });
    await queryClient.refetchQueries({ queryKey: getGetBotStateQueryKey() });
  } } });
  const stop = useStopBot({ mutation: { onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: getGetBotStateQueryKey() });
    await queryClient.refetchQueries({ queryKey: getGetBotStateQueryKey() });
  } } });
  const state = stateQuery.data as BotState | undefined;
  const controlPending = start.isPending || stop.isPending;

  if (stateQuery.isLoading) return <LoadingScreen />;
  if (stateQuery.isError || !state) return <ErrorScreen message={stateQuery.error instanceof Error ? stateQuery.error.message : 'Unable to load the live bot state.'} retry={() => stateQuery.refetch()} />;

  const account = state.account;
  const windowState = state.window;
  const positions = state.positions ?? [];
  const trades = state.trades ?? [];
  const events = state.events ?? [];
  const feedLive = state.btc.status?.toLowerCase() === 'connected' || state.btc.status?.toLowerCase() === 'live';
  const health = healthQuery.data as { status?: string } | undefined;

  return (
    <div className="dashboard-shell flex">
      <aside className="sidebar hidden md:flex md:w-[238px] shrink-0 flex-col px-5 py-6">
        <div className="flex items-center gap-3 px-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2c665] text-[#202936]"><Bitcoin size={23} strokeWidth={2.2} /></div>
          <div><div className="text-[13px] font-extrabold tracking-tight">FIELDNOTE</div><div className="mono mt-0.5 text-[9px] tracking-[.16em] text-[#a5adad]">MARKET SYSTEMS</div></div>
        </div>
        <div className="mt-12">
          <p className="eyebrow px-2 text-[#89929a]">Workspace</p>
          <div className="mt-3 flex items-center gap-3 rounded-lg bg-[#303b48] px-3 py-3 text-[13px] font-semibold text-[#f5f2e8]">
            <Activity size={16} className="text-[#f2c665]" /> Signal accumulator
          </div>
        </div>
        <div className="mt-auto rounded-xl border border-[#45505b] bg-[#27323e] p-4">
          <div className="flex items-center justify-between">
            <span className="eyebrow !text-[#a5adad]">Execution mode</span>
            <span className="rounded bg-[#394852] px-2 py-1 mono text-[9px] font-medium text-[#f2c665]">{state.mode}</span>
          </div>
          <p className="mt-3 text-[12px] leading-5 text-[#bec5c3]">Simulated entries only. No live orders are sent.</p>
          <div className="mt-4 flex items-center gap-2 text-[10px] text-[#a5adad]">
            <ShieldCheck size={13} className="text-[#86b79e]" /> Demo environment
          </div>
        </div>
        <div className="mt-5 flex items-center justify-between px-1 text-[10px] text-[#87919a]">
          <span>API health</span><span className="flex items-center gap-1.5"><i className={`h-1.5 w-1.5 rounded-full ${health?.status ? 'bg-[#80b99c]' : 'bg-[#a5adad]'}`} />{health?.status ?? 'Checking'}</span>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <header className="flex min-h-[74px] items-center justify-between border-b border-[#dcd9cf] bg-[#f7f5ef] px-5 md:px-9">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#202936] text-[#f2c665] md:hidden"><Bitcoin size={18} /></div>
            <div>
              <div className="eyebrow">Demo bot / Bitcoin</div>
              <div className="mt-0.5 text-[12px] font-semibold text-[#55606b]">5-minute signal accumulator</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden items-center gap-2 rounded-full border border-[#dfddd4] bg-[#fbfaf6] px-3 py-2 sm:flex">
              <span className={`h-2 w-2 rounded-full ${state.running ? 'status-dot bg-[#2c8869] text-[#2c8869]' : 'bg-[#92999a]'}`} />
              <span className="text-[11px] font-bold">{state.running ? 'Running' : 'Stopped'}</span>
            </div>
            {state.running ? (
              <button data-testid="button-stop-bot" onClick={() => stop.mutate()} disabled={controlPending} className="flex h-10 items-center gap-2 rounded-lg border border-[#d5aaa3] bg-[#fff8f5] px-4 text-[12px] font-bold text-[#a64e43] transition hover:bg-[#f9e9e4] disabled:opacity-50">
                {controlPending ? <RefreshCw size={14} className="animate-spin" /> : <span className="h-2 w-2 rounded-sm bg-current" />} Stop bot
              </button>
            ) : (
              <button data-testid="button-start-bot" onClick={() => start.mutate()} disabled={controlPending} className="flex h-10 items-center gap-2 rounded-lg bg-[#202936] px-4 text-[12px] font-bold text-[#f7f1df] transition hover:bg-[#33404e] disabled:opacity-50">
                {controlPending ? <RefreshCw size={14} className="animate-spin" /> : <span className="h-2 w-2 rounded-full bg-[#f2c665]" />} Start bot
              </button>
            )}
          </div>
        </header>

        <div className="mx-auto max-w-[1500px] px-4 pb-10 pt-6 md:px-9 md:pt-8">
          {(state.error || (start.error instanceof Error ? start.error.message : '') || (stop.error instanceof Error ? stop.error.message : '')) && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-[#e7c5bd] bg-[#fff5f1] px-4 py-3 text-[12px] text-[#9b4d42]" data-testid="status-bot-error">
              <span className="font-bold">Attention</span><span>{state.error || (start.error instanceof Error ? start.error.message : '') || (stop.error instanceof Error ? stop.error.message : '')}</span>
            </div>
          )}
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4 fade-up">
            <div>
              <div className="eyebrow flex items-center gap-2"><span className="inline-block h-1.5 w-1.5 rounded-full bg-[#d9a947]" /> Live operations</div>
              <h1 className="mt-2 text-[28px] font-extrabold leading-none tracking-[-.055em] md:text-[36px]">No TP, NO SL</h1>
              <p className="mt-2 text-[12px] text-[#7d8389]">Signal polling · position accumulation · official market settlement</p>
            </div>
            <div className="mono flex items-center gap-2 pb-1 text-[11px] text-[#798087]"><RefreshCw size={12} /> Updated {time(state.now)}</div>
          </div>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Portfolio equity" value={money(account.equity)} sub={`Capital ${money(account.capital)}`} icon={<Wallet size={15} />} accent />
            <Metric label="Net total P&L" value={money(account.totalPnl)} sub={`Realized ${money(account.realizedPnl)}`} icon={<Activity size={15} />} positive={account.totalPnl >= 0} />
            <Metric label="Open positions" value={String(positions.length)} sub={`Open value ${money(account.openValue)}`} icon={<Layers3 size={15} />} />
            <Metric label="Time active" value={duration(state.uptimeSec)} sub={`Max drawdown ${money(account.maxDrawdown)}`} icon={<Clock3 size={15} />} />
          </section>

          <section className="mt-5 grid gap-4 xl:grid-cols-[1.55fr_1fr]">
            <div className="panel overflow-hidden rounded-xl">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e8e5dc] px-5 py-4 md:px-6">
                <div><div className="eyebrow">Current market window</div><h2 className="mt-1 text-[15px] font-extrabold tracking-tight">{windowState?.slug ?? 'No active market window'}</h2></div>
                <div className="flex items-center gap-2 rounded-full bg-[#f0eee6] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[#6d747a]"><span className={`h-1.5 w-1.5 rounded-full ${windowState?.closed ? 'bg-[#92999a]' : state.running ? 'bg-[#34866a]' : 'bg-[#c3a768]'}`} />{windowState?.status ?? 'Idle'}</div>
              </div>
              {windowState ? <div className="grid gap-5 px-5 py-5 md:grid-cols-[1fr_1.2fr] md:px-6">
                <div className="flex flex-col justify-between">
                  <div>
                    <div className="eyebrow">Window closes in</div>
                    <div className="mono mt-1 text-[42px] font-medium leading-none tracking-[-.08em] md:text-[50px]" data-testid="text-window-countdown">{duration(windowState.secondsRemaining)}</div>
                    <div className="mt-2 text-[11px] text-[#7d8389]">Opened {time(windowState.openTs)} <span className="mx-1 text-[#b7b5ae]">/</span> closes {time(windowState.closeTs)}</div>
                  </div>
                  <div className="mt-6">
                    <div className="mb-2 flex justify-between text-[10px] text-[#81878c]"><span>Window progress</span><span className="mono">{Math.round(Math.min(100, Math.max(0, windowState.elapsedSeconds / 300 * 100)))}%</span></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#e8e5dc]"><div className="h-full rounded-full bg-[#d4a643] transition-all" style={{ width: `${Math.min(100, Math.max(0, windowState.elapsedSeconds / 300 * 100))}%` }} /></div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-[#f2f0e9] p-3.5">
                    <div className="eyebrow">Entries this window</div><div className="mono mt-2 text-[25px] font-medium">{windowState.entriesThisWindow}</div>
                    <div className="mt-1 text-[10px] text-[#858a8d]">One simulated entry per qualifying poll</div>
                  </div>
                  <div className="rounded-lg bg-[#f2f0e9] p-3.5">
                    <div className="eyebrow">Signal direction</div><div className={`mt-2 flex items-center gap-2 text-[18px] font-extrabold ${windowState.activeSignalSide === 'UP' ? 'up-color' : windowState.activeSignalSide === 'DOWN' ? 'down-color' : 'text-[#858a8d]'}`}>{windowState.activeSignalSide === 'UP' ? <ArrowUpRight size={19} /> : windowState.activeSignalSide === 'DOWN' ? <ArrowDownRight size={19} /> : <span className="h-[2px] w-4 bg-current" />}{windowState.activeSignalSide ?? 'Waiting'}</div>
                    <div className="mt-1 text-[10px] text-[#858a8d]">{windowState.lastSignal ? `Last ${compact(windowState.lastSignal.changeUsd)} USD change` : 'No qualifying signal yet'}</div>
                  </div>
                  <div className="col-span-2 flex items-center justify-between rounded-lg border border-[#e8e5dc] px-3.5 py-3">
                    <div><div className="eyebrow">Entry delay</div><div className="mt-1 text-[11px] text-[#626c75]">{windowState.entryDelayRemainingSeconds > 0 ? `${compact(windowState.entryDelayRemainingSeconds, 1)}s remaining` : 'Ready for qualifying signals'}</div></div>
                    <span className="mono text-[11px] font-medium text-[#58636c]">{windowState.closed ? 'Closed' : 'Live'}</span>
                  </div>
                </div>
              </div> : <EmptyMessage title="No active window" copy="Market window data will appear when available." />}
            </div>

            <div className="panel rounded-xl p-5 md:p-6">
              <div className="flex items-start justify-between">
                <div><div className="eyebrow">Underlying feed</div><h2 className="mt-1 text-[15px] font-extrabold tracking-tight">{state.btc.exchange} <span className="font-medium text-[#90959a]">/ {state.btc.symbol}</span></h2></div>
                <div className="flex items-center gap-2 rounded-full bg-[#eef3ed] px-2.5 py-1.5 text-[9px] font-bold uppercase tracking-wide text-[#47745e]"><span className={`h-1.5 w-1.5 rounded-full ${feedLive ? 'status-dot bg-[#34866a] text-[#34866a]' : 'bg-[#c19b50]'}`} />{state.btc.status}</div>
              </div>
              <div className="mono mt-5 text-[33px] font-medium tracking-[-.055em]" data-testid="text-btc-price">{money(state.btc.price, 2)}</div>
              <div className={`mono mt-1 flex items-center gap-1 text-[12px] ${Number(state.btc.change1s ?? 0) >= 0 ? 'up-color' : 'down-color'}`}>{Number(state.btc.change1s ?? 0) >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{money(state.btc.change1s, 2)} <span className="font-sans text-[10px] text-[#8b9092]">1 sec change</span></div>
              <div className="mt-5 border-t border-[#e8e5dc] pt-4">
                <div className="flex items-center justify-between"><span className="eyebrow">Adaptive threshold</span><span className={`text-[10px] font-bold ${state.btc.thresholdReady ? 'up-color' : 'text-[#9b7a3b]'}`}>{state.btc.thresholdReady ? 'READY' : 'COLLECTING'}</span></div>
                <div className="mt-2 flex items-end justify-between"><span className="mono text-[19px]">{money(state.btc.thresholdUsd, 2)}</span><span className="mono text-[10px] text-[#81878c]">{state.btc.thresholdSampleCount} / {state.btc.thresholdMinSamples} samples</span></div>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-[#e8e5dc]"><div className="h-full rounded-full bg-[#4e9175]" style={{ width: `${Math.min(100, state.btc.thresholdMinSamples ? state.btc.thresholdSampleCount / state.btc.thresholdMinSamples * 100 : 0)}%` }} /></div>
                <div className="mt-2 flex justify-between text-[9px] text-[#8a8f90]"><span>p{compact(state.btc.thresholdPercentile, 0)} · {compact(state.btc.thresholdWindowMs, 0)}ms window</span><span>Received {time(state.btc.receivedAt)}</span></div>
                {state.btc.error && <p className="mt-2 text-[10px] text-[#a64e43]">{state.btc.error}</p>}
              </div>
            </div>
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[1.3fr_1fr]">
            <div className="panel rounded-xl">
              <div className="flex items-center justify-between border-b border-[#e8e5dc] px-5 py-4 md:px-6"><div><div className="eyebrow">Prediction market quotes</div><h2 className="mt-1 text-[14px] font-extrabold">Polymarket CLOB</h2></div><div className="flex items-center gap-1.5 text-[10px] text-[#838a8e]"><Waves size={13} /> Bid / ask / midpoint</div></div>
              <div className="grid grid-cols-2 divide-x divide-[#e8e5dc]">
                <QuoteCard side="UP" quote={state.prices.up} />
                <QuoteCard side="DOWN" quote={state.prices.down} />
              </div>
              <div className="border-t border-[#e8e5dc] px-5 py-3 text-[10px] text-[#858a8d] md:px-6">Resolution checks use CLOB thresholds and official market resolution.</div>
            </div>
            <div className="panel rounded-xl">
              <div className="flex items-center justify-between border-b border-[#e8e5dc] px-5 py-4 md:px-6"><div><div className="eyebrow">Strategy configuration</div><h2 className="mt-1 text-[14px] font-extrabold">Execution rules</h2></div><Signal size={16} className="text-[#9b854d]" /></div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-4 px-5 py-4 md:px-6">
                <Rule label="Shares per entry" value={compact(state.strategy.sharesPerEntry)} />
                <Rule label="Signal poll" value={`${state.strategy.pollMs} ms`} />
                <Rule label="Entry delay" value={`${compact(state.strategy.entryDelaySeconds, 1)} sec`} />
                <Rule label="Ask price band" value={`${pct(state.strategy.askMin)} – ${pct(state.strategy.askMax)}`} />
                <Rule label="Slippage allowance" value={pct(state.strategy.buySlippagePercent)} />
                <Rule label="Buy price ceiling" value={pct(state.strategy.buyPriceCeiling)} />
                <Rule label="CLOB win midpoint" value={pct(state.strategy.clobWinMidpoint)} />
                <Rule label="CLOB loss best bid" value={pct(state.strategy.clobLossBestBid)} />
                <Rule label="Entries per poll" value={compact(state.strategy.entriesPerPoll, 0)} />
                <Rule label="Demo capital" value={money(state.strategy.demoCapital)} />
              </div>
              <div className="mx-5 mb-4 rounded-lg bg-[#f2f0e9] px-3 py-2.5 text-[10px] leading-4 text-[#68727a] md:mx-6"><strong className="text-[#343e48]">Accumulation only.</strong> UP and DOWN positions can coexist. No take-profit or stop-loss.</div>
            </div>
          </section>

          <section className="panel mt-4 overflow-hidden rounded-xl">
            <div className="flex items-end justify-between border-b border-[#e8e5dc] px-5 py-4 md:px-6"><div><div className="eyebrow">Current positions</div><h2 className="mt-1 text-[14px] font-extrabold">Open inventory</h2></div><span className="mono rounded-md bg-[#f0eee6] px-2 py-1 text-[10px]">{positions.length} active</span></div>
            {positions.length ? <PositionsTable positions={positions} /> : <EmptyMessage title={state.running ? 'No open positions yet' : 'Bot stopped · no open positions'} copy={state.running ? 'Waiting for the next qualifying signal inside the price band.' : 'Existing inventory remains in the account state; no new entries are being placed.'} />}
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_1fr]">
            <div className="panel overflow-hidden rounded-xl">
              <div className="flex items-end justify-between border-b border-[#e8e5dc] px-5 py-4 md:px-6"><div><div className="eyebrow">Settlement ledger</div><h2 className="mt-1 text-[14px] font-extrabold">Settled trades</h2></div><span className="mono text-[10px] text-[#81878c]">{account.wins}W <span className="px-1 text-[#b9b6ad]">/</span> {account.losses}L</span></div>
              {trades.length ? <TradesTable trades={trades} /> : <EmptyMessage title="No settled trades" copy="Resolved positions will appear here with their settlement source and result." />}
            </div>
            <div className="panel overflow-hidden rounded-xl">
              <div className="flex items-center justify-between border-b border-[#e8e5dc] px-5 py-4 md:px-6"><div><div className="eyebrow">Bot activity</div><h2 className="mt-1 text-[14px] font-extrabold">Event stream</h2></div><Radio size={15} className={state.running ? 'text-[#34866a]' : 'text-[#a7a59e]'} /></div>
              {events.length ? <EventList events={events} /> : <EmptyMessage title="No events yet" copy="Signal polls, entries, and settlements will be recorded here." />}
            </div>
          </section>
          <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pb-3 pt-5 text-[10px] text-[#898d8d]">
            <span>Demo-only strategy · simulated execution</span><span className="mono">Cash {money(account.cash)} · Unrealized {money(account.unrealizedPnl)} · Fees {money(account.estimatedFees)} · Feed age {state.btc.ageMs == null ? '—' : `${compact(state.btc.ageMs, 0)} ms`}</span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function Metric({ label, value, sub, icon, accent, positive }: { label: string; value: string; sub: string; icon: ReactNode; accent?: boolean; positive?: boolean }) {
  return <div className={`panel rounded-xl p-4 md:p-5 ${accent ? 'border-t-[2px] border-t-[#d5a947]' : ''}`} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="flex items-center justify-between"><span className="eyebrow">{label}</span><span className="text-[#a49a7c]">{icon}</span></div>
    <div className={`mono mt-3 text-[23px] font-medium tracking-[-.055em] md:text-[26px] ${positive === undefined ? '' : positive ? 'up-color' : 'down-color'}`}>{value}</div>
    <div className="mt-1 text-[10px] text-[#858a8d]">{sub}</div>
  </div>;
}

function QuoteCard({ side, quote }: { side: 'UP' | 'DOWN'; quote: { bid: number | null; ask: number | null; mid: number | null } }) {
  return <div className="px-5 py-4 md:px-6">
    <div className={`flex items-center gap-2 text-[11px] font-extrabold tracking-wide ${side === 'UP' ? 'up-color' : 'down-color'}`}><span className={`h-2 w-2 rounded-sm ${side === 'UP' ? 'bg-[#34866a]' : 'bg-[#c05b4e]'}`} />{side}</div>
    <div className="mono mt-3 text-[25px] font-medium">{pct(quote.mid)}</div>
    <div className="mt-3 grid grid-cols-2 gap-3 text-[10px]"><div><span className="block text-[#8a8e8e]">Bid</span><span className="mono mt-1 block text-[12px]">{pct(quote.bid)}</span></div><div><span className="block text-[#8a8e8e]">Ask</span><span className="mono mt-1 block text-[12px]">{pct(quote.ask)}</span></div></div>
  </div>;
}

function Rule({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><div className="text-[10px] text-[#858a8d]">{label}</div><div className="mono mt-1 truncate text-[11px] font-medium text-[#333e49]">{value}</div></div>;
}

function PositionsTable({ positions }: { positions: Position[] }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[780px] text-left"><thead><tr className="bg-[#f6f4ee] text-[9px] uppercase tracking-[.11em] text-[#878b8b]"><th className="px-5 py-3 font-bold">Side / market</th><th className="px-4 py-3 font-bold">Opened</th><th className="px-4 py-3 font-bold">Shares</th><th className="px-4 py-3 font-bold">Entry</th><th className="px-4 py-3 font-bold">Mark</th><th className="px-4 py-3 font-bold">Unrealized P&L</th><th className="px-5 py-3 font-bold">Status</th></tr></thead><tbody>{positions.map(p => <tr key={p.id} data-testid={`row-position-${p.id}`} className="border-t border-[#eeece5] text-[11px]">
    <td className="px-5 py-3.5"><span className={`font-extrabold ${p.side === 'UP' ? 'up-color' : 'down-color'}`}>{p.side}</span><span className="ml-2 text-[10px] text-[#8a8e8e]">{p.slug}</span><div className="mt-1 text-[9px] text-[#929694]">Signal {money(p.signalChangeUsd)} · polled {time(p.signalPollAt)}</div></td>
    <td className="mono px-4 py-3.5 text-[#626b72]">{time(p.openedAt)}</td><td className="mono px-4 py-3.5">{compact(p.openShares)}</td><td className="mono px-4 py-3.5">{pct(p.entryPrice)}</td><td className="mono px-4 py-3.5">{pct(p.mark)}</td><td className={`mono px-4 py-3.5 ${Number(p.unrealizedPnl ?? 0) >= 0 ? 'up-color' : 'down-color'}`}>{money(p.unrealizedPnl)}</td><td className="px-5 py-3.5"><span className="rounded bg-[#f0eee6] px-2 py-1 text-[9px] font-bold uppercase text-[#737a7e]">{p.status}</span></td>
  </tr>)}</tbody></table></div>;
}

function TradesTable({ trades }: { trades: Trade[] }) {
  return <div className="max-h-[330px] overflow-auto"><table className="w-full min-w-[700px] text-left"><thead className="sticky top-0 bg-[#f6f4ee]"><tr className="text-[9px] uppercase tracking-[.1em] text-[#878b8b]"><th className="px-5 py-3 font-bold">Side / winner</th><th className="px-3 py-3 font-bold">Result</th><th className="px-3 py-3 font-bold">Shares</th><th className="px-3 py-3 font-bold">Payout</th><th className="px-3 py-3 font-bold">Net P&L</th><th className="px-5 py-3 font-bold">Settlement</th></tr></thead><tbody>{trades.map(t => <tr key={t.id} data-testid={`row-trade-${t.id}`} className="border-t border-[#eeece5] text-[10px]"><td className="px-5 py-3"><span className={`font-extrabold ${t.side === 'UP' ? 'up-color' : 'down-color'}`}>{t.side}</span><span className="ml-2 text-[9px] text-[#919694]">winner {t.winner} · {time(t.closedAt)}</span></td><td className="px-3 py-3"><span className={`rounded px-2 py-1 text-[9px] font-bold ${t.result === 'WIN' ? 'bg-[#e7f0e9] text-[#39745b]' : 'bg-[#f7e8e4] text-[#a64e43]'}`}>{t.result}</span></td><td className="mono px-3 py-3">{compact(t.shares)}</td><td className="mono px-3 py-3">{money(t.payout)}</td><td className={`mono px-3 py-3 ${t.netPnl >= 0 ? 'up-color' : 'down-color'}`}>{money(t.netPnl)}</td><td className="px-5 py-3 text-[#737a7e]">{t.settlementSource === 'CLOB_THRESHOLD' ? 'CLOB threshold' : 'Official resolution'}</td></tr>)}</tbody></table></div>;
}

function EventList({ events }: { events: BotEvent[] }) {
  return <div className="max-h-[330px] overflow-y-auto px-5 py-1 md:px-6">{events.map((event, i) => <div key={`${event.ts}-${i}`} data-testid={`event-row-${i}`} className="flex gap-3 border-b border-[#eeece5] py-3 last:border-0">
    <span className="mono mt-0.5 w-[58px] shrink-0 text-[9px] text-[#8c9190]">{time(event.ts)}</span><span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${event.side === 'UP' ? 'bg-[#34866a]' : event.side === 'DOWN' ? 'bg-[#c05b4e]' : 'bg-[#d1a94f]'}`} />
    <div className="min-w-0"><div className="text-[10px] font-extrabold text-[#3c4650]">{event.event}</div><div className="mt-0.5 break-words text-[10px] leading-4 text-[#81878c]">{event.note}</div>{event.slug && <div className="mono mt-1 truncate text-[9px] text-[#a0a29d]">{event.slug}</div>}</div>
  </div>)}</div>;
}

function EmptyMessage({ title, copy }: { title: string; copy: string }) {
  return <div className="flex min-h-[112px] flex-col items-center justify-center px-6 py-7 text-center"><div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-[#f0eee6] text-[#9a947f]"><Gauge size={15} /></div><div className="text-[11px] font-bold text-[#56616a]">{title}</div><p className="mt-1 max-w-[360px] text-[10px] leading-4 text-[#8a8f90]">{copy}</p></div>;
}

function LoadingScreen() {
  return <div className="dashboard-shell min-h-[100dvh]"><div className="mx-auto max-w-[1350px] p-6 md:p-10"><div className="h-8 w-56 animate-pulse rounded bg-[#dfddd4]" /><div className="mt-3 h-4 w-72 animate-pulse rounded bg-[#e7e4dc]" /><div className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-28 animate-pulse rounded-xl border border-[#dfddd4] bg-[#f8f6f0]" />)}</div><div className="mt-5 grid gap-4 lg:grid-cols-2"><div className="h-72 animate-pulse rounded-xl border border-[#dfddd4] bg-[#f8f6f0]" /><div className="h-72 animate-pulse rounded-xl border border-[#dfddd4] bg-[#f8f6f0]" /></div></div></div>;
}

function ErrorScreen({ message, retry }: { message: string; retry: () => void }) {
  return <div className="dashboard-shell flex min-h-[100dvh] items-center justify-center px-5"><div className="panel max-w-md rounded-2xl p-8 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-[#f6e9e4] text-[#a64e43]"><Radio size={20} /></div><p className="eyebrow mt-5">Live state unavailable</p><h1 className="mt-2 text-xl font-extrabold">Could not reach the bot</h1><p className="mt-2 text-sm leading-6 text-[#777f83]">{message}</p><button data-testid="button-retry-state" onClick={retry} className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#202936] px-4 py-2.5 text-xs font-bold text-[#f7f1df] hover:bg-[#33404e]"><RefreshCw size={13} /> Try again</button></div></div>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;