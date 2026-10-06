import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const requireFromBundle = createRequire(import.meta.url);
const ArbitrageBot = requireFromBundle("./bot/arbitrage-bot.js") as new () => {
  start(): Promise<void>;
  stop(): void;
  snapshot(): Record<string, any>;
};
const bot = new ArbitrageBot();
void bot.start();

const router: IRouter = Router();

router.get("/bot/state", (_req, res) => {
  res.json(bot.snapshot());
});

router.post("/bot/start", (_req, res) => {
  const wasRunning = bot.snapshot().running;
  void bot.start();
  res.json({
    running: true,
    mode: "PAPER",
    message: wasRunning ? "Paper scanner is already running." : "Paper scanner started.",
  });
});

router.post("/bot/stop", (_req, res) => {
  const wasRunning = bot.snapshot().running;
  bot.stop();
  res.json({
    running: false,
    mode: "PAPER",
    message: wasRunning ? "Paper scanner stopped." : "Paper scanner is already stopped.",
  });
});

export default router;
