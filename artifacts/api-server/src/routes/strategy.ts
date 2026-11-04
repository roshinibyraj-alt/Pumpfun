import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const require = createRequire(import.meta.url);
const { ProbabilityBot } = require("./bot/btc/probability-bot.js") as {
  ProbabilityBot: new (options: Record<string, unknown>) => {
    start: () => void;
    snapshot: () => unknown;
    learningStore: { getState: () => Promise<unknown> };
  };
};
const { LearningStore } = require("./bot/btc/learning-store.js") as {
  LearningStore: new (pool: unknown) => {
    initialize: (defaults: Record<string, unknown>) => Promise<void>;
    loadSettings: (defaults: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getState: () => Promise<unknown>;
    getPaperAnalytics: (limit?: number) => Promise<unknown>;
    resetHistoryOnce: (requestId: string) => Promise<boolean>;
    clearHistoryResetMarkers: () => Promise<void>;
  };
};
const { DEFAULT_SETTINGS } = require("./bot/btc/learning-engine.js") as {
  DEFAULT_SETTINGS: Record<string, unknown>;
};
const { comparisonService } = require("./bot/btc/comparison-service.js") as {
  comparisonService: (store: unknown) => () => Promise<unknown>;
};

const router: IRouter = Router();
const learningStore = new LearningStore(pool);
await learningStore.initialize(DEFAULT_SETTINGS);
const historyResetRequestId = process.env.BTC_HISTORY_RESET_REQUEST_ID?.trim() || null;
if (historyResetRequestId) {
  await learningStore.resetHistoryOnce(historyResetRequestId);
} else {
  await learningStore.clearHistoryResetMarkers();
}
const getComparison = comparisonService(learningStore);
const bot = new ProbabilityBot({ learningStore });
if (!historyResetRequestId) bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

router.get("/strategy/learning", async (_req, res) => {
  const state = await learningStore.getState() as Record<string, unknown>;
  res.set("Cache-Control", "no-store").json({
    ...state,
    mode: "logging-only-fixed-midpoint-policy",
    settings: {
      orderType: "RESTING_LIMIT",
      orderIntervalSeconds: 20,
      cheapPhase: { throughSecond: 120, sharesPerOrder: 100 },
      expensivePhase: { fromSecond: 140, throughSecond: 240, sharesPerOrder: 300 },
      cancelUnfilledAtWindowEnd: true,
    },
    tuningEnabled: false,
  });
});

router.get("/strategy/analytics", async (req, res) => {
  try {
    const limit = Number(req.query.limit);
    const safeLimit = Number.isInteger(limit) ? Math.min(1200, Math.max(50, limit)) : 1000;
    res.set("Cache-Control", "no-store").json(await learningStore.getPaperAnalytics(safeLimit));
  } catch (error) {
    req.log.error({ err: error }, "Paper analytics query failed");
    res.status(503).json({ error: "Paper performance history is temporarily unavailable." });
  }
});

router.get("/strategy/comparison", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await getComparison());
  } catch (error) {
    req.log.error({ err: error }, "Strategy comparison failed");
    res.status(503).json({ error: "Strategy comparison is unavailable; no trading settings were changed." });
  }
});

export default router;
