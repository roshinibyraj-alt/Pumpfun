import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const require = createRequire(import.meta.url);
const { CrossPairBot } = require("./bot/btc/cross-pair-bot.cjs") as {
  CrossPairBot: new () => {
    start: () => void;
    snapshot: () => unknown;
  };
};

const router: IRouter = Router();
const bot = new CrossPairBot();
bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

export default router;
