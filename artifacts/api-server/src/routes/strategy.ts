import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const require = createRequire(import.meta.url);
const { BtcMispricingBot } = require("./bot/btc/mispricing-bot.cjs") as {
  BtcMispricingBot: new (options?: {
    stateStore?: unknown;
  }) => {
    start: () => void | Promise<void>;
    snapshot: () => unknown;
  };
};
const { PaperStateStore } = require("./bot/btc/paper-state-store.cjs") as {
  PaperStateStore: new (databasePool: typeof pool, botKey?: string) => unknown;
};
const { LegacyPaperSettlementWorker } = require("./bot/btc/legacy-paper-settlement.cjs") as {
  LegacyPaperSettlementWorker: new (options?: {
    stateStore?: unknown;
    onError?: (error: Error) => void;
  }) => {
    start: () => void | Promise<void>;
  };
};

const router: IRouter = Router();
const bot = new BtcMispricingBot({
  stateStore: new PaperStateStore(pool, "btc-5m-mispricing"),
});
const legacySettlementWorker = new LegacyPaperSettlementWorker({
  stateStore: new PaperStateStore(pool, "btc-5m-price-band"),
});
void bot.start();
void legacySettlementWorker.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

export default router;
