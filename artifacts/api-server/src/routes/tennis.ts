import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const requireFromBundle = createRequire(import.meta.url);
const { TennisPaperBot } = requireFromBundle("./bot/tennis-bot.js") as {
  TennisPaperBot: new () => {
    start(): Promise<void>;
    stop(): void;
    snapshot(): Record<string, any>;
    previewMarket(input: Record<string, unknown>): Promise<Record<string, any>>;
    addMarket(input: Record<string, unknown>): Promise<Record<string, any>>;
    removeMarket(id: string): Promise<void>;
  };
};

const bot = new TennisPaperBot();
void bot.start();
const router: IRouter = Router();

router.get("/tennis/state", (_req, res) => res.json(bot.snapshot()));
router.get("/bot/state", (_req, res) => res.json(bot.snapshot()));
router.post("/tennis/preview", async (req, res) => {
  try {
    res.json(await bot.previewMarket(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message || error) });
  }
});
router.post("/tennis/markets", async (req, res) => {
  try {
    const market = await bot.addMarket(req.body || {});
    res.status(201).json({ market, state: bot.snapshot() });
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message || error) });
  }
});
router.delete("/tennis/markets/:id", async (req, res) => {
  try {
    await bot.removeMarket(String(req.params.id));
    res.json(bot.snapshot());
  } catch (error) {
    res.status(400).json({ error: String((error as Error)?.message || error) });
  }
});
router.post("/tennis/stop", (_req, res) => {
  bot.stop();
  res.json(bot.snapshot());
});
router.post("/bot/start", async (_req, res) => {
  await bot.start();
  res.json({ running: true, mode: "PAPER", message: "Tennis paper bot is running." });
});
router.post("/bot/stop", (_req, res) => {
  bot.stop();
  res.json({ running: false, mode: "PAPER", message: "Tennis paper bot stopped." });
});
router.post("/tennis/start", async (_req, res) => {
  await bot.start();
  res.json(bot.snapshot());
});

export default router;
