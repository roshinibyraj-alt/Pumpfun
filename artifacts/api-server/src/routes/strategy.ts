import { createRequire } from "node:module";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const require = createRequire(import.meta.url);
const { BtcPriceBandBot } = require("./bot/btc/btc-price-band-bot.cjs") as {
  BtcPriceBandBot: new (options?: {
    stateStore?: unknown;
    requirePersistedState?: boolean;
  }) => {
    start: () => void | Promise<void>;
    snapshot: () => unknown;
  };
};
const { PaperStateStore } = require("./bot/btc/paper-state-store.cjs") as {
  PaperStateStore: new (databasePool: typeof pool) => unknown;
};

const router: IRouter = Router();
const bot = new BtcPriceBandBot({
  stateStore: new PaperStateStore(pool),
  requirePersistedState: true,
});
void bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

export default router;
