import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const require = createRequire(import.meta.url);
const { ProbabilityBot } = require("./bot/btc/probability-bot.js") as {
  ProbabilityBot: new () => { start: () => void; snapshot: () => unknown };
};

const router: IRouter = Router();
const bot = new ProbabilityBot();
bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

export default router;
