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
  STRATEGY_VERSION,
  SIGNAL_SCAN_LEAD_MS,
  SIGNAL_COMPARE_LEAD_MS,
  ENTRY_SHARES,
  POLL_INTERVAL_MS,
} = require(
  "./bot/btc/signal-taker-strategy.js",
) as {
  STRATEGY_VERSION: string;
  SIGNAL_SCAN_LEAD_MS: number;
  SIGNAL_COMPARE_LEAD_MS: number;
  ENTRY_SHARES: number;
  POLL_INTERVAL_MS: number;
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
      orderType: "TAKER",
      signalScanLeadMs: SIGNAL_SCAN_LEAD_MS,
      signalCompareLeadMs: SIGNAL_COMPARE_LEAD_MS,
      sharesPerTrade: ENTRY_SHARES,
      pollIntervalMs: POLL_INTERVAL_MS,
      exitPolicy: "POLYMARKET_RESOLUTION_ONLY",
      stopLoss: false,
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
