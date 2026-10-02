import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import {
  GetBotStateResponse,
  StartBotResponse,
  StopBotResponse,
} from "@workspace/api-zod";

type FeedQuote = { bid: number | null; ask: number | null; mid: number | null };
type DemoBot = {
  start(): void;
  stop(): void;
  snapshot(): Record<string, any>;
};

const requireFromBundle = createRequire(import.meta.url);
const Bot = requireFromBundle("./bot/directional-bot.js") as new (
  trader: unknown,
  options?: { live?: boolean },
) => DemoBot;
const DemoTrader = requireFromBundle("./bot/demo-trader.js") as new () => unknown;
const bot = new Bot(new DemoTrader(), { live: false });
bot.start();

const router: IRouter = Router();

function apiQuote(value?: Partial<FeedQuote> | null): FeedQuote {
  return {
    bid: value?.bid ?? null,
    ask: value?.ask ?? null,
    mid: value?.mid ?? null,
  };
}

function toApiState(snapshot: Record<string, any>) {
  const now = Number(snapshot.now) || Date.now();
  const sourceWindow = snapshot.window;
  const sourceFeed = snapshot.ccxt ?? {};
  const sourceAccount = snapshot.account ?? {};
  const sourceStrategy = snapshot.strategy ?? {};
  const sourcePrices = snapshot.prices ?? {};

  return {
    running: Boolean(snapshot.running),
    mode: "DEMO" as const,
    now,
    uptimeSec: Number(snapshot.uptimeSec) || 0,
    error: snapshot.error ?? null,
    account: {
      capital: Number(sourceAccount.capital) || 0,
      cash: Number(sourceAccount.cash) || 0,
      openValue: Number(sourceAccount.openValue) || 0,
      unrealizedPnl: Number(sourceAccount.unrealizedPnl) || 0,
      equity: Number(sourceAccount.equity) || 0,
      totalPnl: Number(sourceAccount.totalPnl) || 0,
      maxDrawdown: Number(sourceAccount.maxDrawdown) || 0,
      realizedPnl: Number(snapshot.stats?.realizedPnl) || 0,
      estimatedFees: Number(snapshot.stats?.estimatedFees) || 0,
      wins: Number(snapshot.stats?.wins) || 0,
      losses: Number(snapshot.stats?.losses) || 0,
    },
    window: sourceWindow
      ? {
          slug: String(sourceWindow.slug),
          status: String(sourceWindow.status),
          openTs: Number(sourceWindow.openTs) || 0,
          closeTs: Number(sourceWindow.closeTs) || 0,
          elapsedSeconds: Number(sourceWindow.elapsedSeconds) || 0,
          secondsRemaining: Math.max(0, (Number(sourceWindow.closeTs) || 0) - now / 1000),
          closed: Boolean(sourceWindow.closed),
          entryDelayRemainingSeconds: Number(sourceWindow.entryDelayRemainingSeconds) || 0,
          entriesThisWindow: Number(sourceWindow.entriesThisWindow) || 0,
          activeSignalSide: sourceWindow.activeSignalSide === "UP" || sourceWindow.activeSignalSide === "DOWN"
            ? sourceWindow.activeSignalSide
            : null,
          lastSignal: sourceWindow.lastSignal
            ? {
                side: sourceWindow.lastSignal.side,
                changeUsd: Number(sourceWindow.lastSignal.changeUsd) || 0,
                thresholdUsd: Number(sourceWindow.lastSignal.thresholdUsd) || 0,
                lookbackMs: Number(sourceWindow.lastSignal.lookbackMs) || 0,
                ts: Number(sourceWindow.lastSignal.ts) || now,
              }
            : null,
        }
      : null,
    btc: {
      exchange: String(sourceFeed.exchange || "coinbase"),
      symbol: String(sourceFeed.symbol || "BTC/USD"),
      status: String(sourceFeed.status || "stopped"),
      price: sourceFeed.price == null ? null : Number(sourceFeed.price),
      change1s: sourceFeed.change1s == null ? null : Number(sourceFeed.change1s),
      thresholdUsd: sourceFeed.thresholdUsd == null ? null : Number(sourceFeed.thresholdUsd),
      thresholdReady: Boolean(sourceFeed.thresholdReady),
      thresholdSampleCount: Number(sourceFeed.thresholdSampleCount) || 0,
      thresholdMinSamples: Number(sourceFeed.thresholdMinSamples) || 120,
      thresholdPercentile: Number(sourceFeed.thresholdPercentile) || 99,
      thresholdWindowMs: Number(sourceFeed.thresholdWindowMs) || 1_200_000,
      receivedAt: sourceFeed.receivedAt == null ? null : Number(sourceFeed.receivedAt),
      ageMs: sourceFeed.ageMs == null ? null : Number(sourceFeed.ageMs),
      error: sourceFeed.error ?? null,
    },
    prices: {
      up: apiQuote(sourcePrices.up),
      down: apiQuote(sourcePrices.down),
    },
    strategy: {
      demoCapital: Number(sourceStrategy.demoCapital) || 1000,
      sharesPerEntry: Number(sourceStrategy.baseShares) || 100,
      entryDelaySeconds: Number(sourceStrategy.entryDelayAfterWindowStartSeconds) || 3,
      signalCooldownSeconds: Number(sourceStrategy.signalCooldownSeconds) || 10,
      pollMs: Number(sourceStrategy.pollMs) || 500,
      askMin: 0.2,
      askMax: 0.8,
      buySlippagePercent: (Number(sourceStrategy.maxBuySlippagePercent) || 50) / 100,
      buyPriceCeiling: 0.99,
      clobWinMidpoint: Number(sourceStrategy.clobWinSettlementPrice) || 0.99,
      clobLossBestBid: Number(sourceStrategy.clobLossSettlementPrice) || 0.01,
      entriesPerPoll: 1,
    },
    positions: (snapshot.pending ?? []).map((position: Record<string, any>) => ({
      id: String(position.id),
      slug: String(position.slug),
      side: position.side,
      openedAt: Number(position.firedAt) || now,
      openTs: Number(position.openTs) || 0,
      closeTs: Number(position.closeTs) || 0,
      shares: Number(position.shares) || 0,
      openShares: Number(position.openShares) || 0,
      entryPrice: Number(position.entryPrice) || 0,
      mark: position.mark == null ? null : Number(position.mark),
      unrealizedPnl: position.unrealized == null ? null : Number(position.unrealized),
      status: String(position.status || "position_open"),
      signalChangeUsd: Number(position.signalChangeUsd) || 0,
      signalPollAt: Number(position.signalTs) || now,
    })),
    trades: (snapshot.trades ?? []).map((trade: Record<string, any>) => ({
      id: String(trade.id),
      slug: String(trade.slug),
      side: trade.side,
      shares: Number(trade.shares) || 0,
      entryPrice: Number(trade.entryPrice) || 0,
      payout: Number(trade.exitProceeds) || 0,
      netPnl: Number(trade.pnl) || 0,
      result: trade.outcome,
      winner: trade.winner,
      settlementSource: trade.reason === "CLOB_THRESHOLD" ? "CLOB_THRESHOLD" : "OFFICIAL_RESOLUTION",
      closedAt: Number(trade.ts) || now,
    })),
    events: (snapshot.log ?? []).map((event: Record<string, any>) => ({
      ts: Number(event.ts) || now,
      event: String(event.event || "BOT_EVENT"),
      note: String(event.note || event.event || "Bot activity"),
      side: event.side === "UP" || event.side === "DOWN" ? event.side : null,
      slug: event.slug == null ? null : String(event.slug),
    })),
  };
}

router.get("/bot/state", (_req, res) => {
  res.json(GetBotStateResponse.parse(toApiState(bot.snapshot())));
});

router.post("/bot/start", (_req, res) => {
  const wasRunning = Boolean(bot.snapshot().running);
  bot.start();
  res.json(StartBotResponse.parse({
    running: true,
    message: wasRunning ? "Demo bot is already running." : "Demo bot started.",
  }));
});

router.post("/bot/stop", (_req, res) => {
  const wasRunning = Boolean(bot.snapshot().running);
  bot.stop();
  res.json(StopBotResponse.parse({
    running: false,
    message: wasRunning ? "Demo bot stopped." : "Demo bot is already stopped.",
  }));
});

export default router;