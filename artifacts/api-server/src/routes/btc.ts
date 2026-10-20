import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const requireFromBundle = createRequire(import.meta.url);
const MultiBot = requireFromBundle("./bot/btc/multi-bot.js") as new () => {
  start(): void;
  stop(): void;
  snapshot(): Record<string, any>;
};

const bot = new MultiBot();
bot.start();
const router: IRouter = Router();

router.get("/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});
router.get("/bot/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});
router.post("/bot/start", (_req, res) => {
  bot.start();
  res.json({ running: true, mode: "DEMO ONLY", message: "BTC 5-minute paper bot is running." });
});
router.post("/bot/stop", (_req, res) => {
  bot.stop();
  res.json({ running: false, mode: "DEMO ONLY", message: "BTC 5-minute paper bot stopped." });
});

export default router;
