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
    loadPullbackBias: () => Promise<"UP" | "DOWN" | null>;
    getState: () => Promise<unknown>;
  };
};
const { DEFAULT_SETTINGS, choosePaperSettings } = require("./bot/btc/learning-engine.js") as {
  DEFAULT_SETTINGS: Record<string, unknown>;
  choosePaperSettings: (windows: unknown[], current: Record<string, unknown>) => unknown;
};

const router: IRouter = Router();
const learningStore = new LearningStore(pool);
await learningStore.initialize(DEFAULT_SETTINGS);
const bot = new ProbabilityBot({
  learningStore,
  choosePaperSettings,
});
bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

router.get("/strategy/learning", async (_req, res) => {
  const state = await learningStore.getState() as Record<string, unknown>;
  res.set("Cache-Control", "no-store").json({
    ...state,
    mode: "logging-only-fixed-policy",
    settings: DEFAULT_SETTINGS,
    tuningEnabled: false,
  });
});

export default router;
