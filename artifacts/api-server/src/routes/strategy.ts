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
const { STRATEGY_VERSION, ENTRY_TRIGGER_SECONDS, ENTRY_TRIGGER_PRICE, LIMIT_ORDER_LADDER } = require(
  "./bot/btc/midpoint-limit-strategy.js",
) as {
  STRATEGY_VERSION: string;
  ENTRY_TRIGGER_SECONDS: number;
  ENTRY_TRIGGER_PRICE: number;
  LIMIT_ORDER_LADDER: Array<{ slot: number; price: number; shares: number }>;
};
const { LearningStore } = require("./bot/btc/learning-store.js") as {
  LearningStore: new (pool: unknown) => {
    initialize: () => Promise<void>;
    getLearningSummary: (strategyVersion: string) => Promise<Record<string, unknown>>;
    getPaperAnalytics: (limit?: number, strategyVersion?: string) => Promise<unknown>;
    resetHistoryOnce: (requestId: string) => Promise<boolean>;
    clearHistoryResetMarkers: () => Promise<void>;
  };
};

const router: IRouter = Router();
const learningStore = new LearningStore(pool);
await learningStore.initialize();
const historyResetRequestId = process.env.BTC_HISTORY_RESET_REQUEST_ID?.trim() || null;
if (historyResetRequestId) {
  await learningStore.resetHistoryOnce(historyResetRequestId);
} else {
  await learningStore.clearHistoryResetMarkers();
}
const bot = new ProbabilityBot({ learningStore });
if (!historyResetRequestId) bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

router.get("/strategy/learning", async (_req, res) => {
  const summary = await learningStore.getLearningSummary(STRATEGY_VERSION);
  res.set("Cache-Control", "no-store").json({
    ...summary,
    settings: {
      orderType: "RESTING_LIMIT",
      entryTriggerSeconds: ENTRY_TRIGGER_SECONDS,
      entryTriggerMidpoint: ENTRY_TRIGGER_PRICE,
      limitOrderLadder: LIMIT_ORDER_LADDER,
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
