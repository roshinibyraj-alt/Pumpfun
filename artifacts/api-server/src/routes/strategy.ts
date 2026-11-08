import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const require = createRequire(import.meta.url);
const { ProbabilityBot } = require("./bot/btc/probability-bot.js") as {
  ProbabilityBot: new (options: Record<string, unknown>) => {
    start: () => void;
    snapshot: () => unknown;
  };
};
const {
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
} = require(
  "./bot/btc/paper-trading.js",
) as {
  ENTRY_SHARES: number;
  POLL_INTERVAL_MS: number;
};
const { STRATEGY_VERSION, RENKO_ATR_PERIOD } = require(
  "./bot/btc/renko-strategy.js",
) as {
  STRATEGY_VERSION: string;
  RENKO_ATR_PERIOD: number;
};
const { LearningStore } = require("./bot/btc/learning-store.js") as {
  LearningStore: new (pool: unknown) => {
    initialize: () => Promise<void>;
    getLearningSummary: (strategyVersion: string) => Promise<Record<string, unknown>>;
    getPaperAnalytics: (limit?: number, strategyVersion?: string) => Promise<unknown>;
  };
};

const router: IRouter = Router();
const learningStore = new LearningStore(pool);
await learningStore.initialize();
const bot = new ProbabilityBot({ learningStore });
bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

router.get("/strategy/learning", async (_req, res) => {
  const summary = await learningStore.getLearningSummary(STRATEGY_VERSION);
  res.set("Cache-Control", "no-store").json({
    ...summary,
    settings: {
      timeframe: "5m",
      signalTimeframe: "1m",
      renkoBrickSizeMethod: `ATR(${RENKO_ATR_PERIOD}) from closed 1-minute BTC candles`,
      orderType: "TAKER",
      sharesPerTrade: ENTRY_SHARES,
      pollIntervalMs: POLL_INTERVAL_MS,
      exitPolicy: "OPPOSITE_RENKO_SIGNAL_OR_POLYMARKET_RESOLUTION",
      stopLoss: false,
      takeProfit: false,
    },
  });
});

router.get("/strategy/analytics", async (req, res) => {
  try {
    const limit = Number(req.query.limit);
    const safeLimit = Number.isInteger(limit) ? Math.min(1200, Math.max(50, limit)) : 1000;
    res.set("Cache-Control", "no-store").json(
      await learningStore.getPaperAnalytics(safeLimit, STRATEGY_VERSION),
    );
  } catch (error) {
    req.log.error({ err: error }, "Paper analytics query failed");
    res.status(503).json({ error: "Paper performance history is temporarily unavailable." });
  }
});

export default router;
