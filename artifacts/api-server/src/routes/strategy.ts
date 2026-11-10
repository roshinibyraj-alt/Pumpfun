import { createRequire } from "node:module";
import { Router, type IRouter } from "express";

const require = createRequire(import.meta.url);
const { BtcPriceBandBot } = require("./bot/btc/btc-price-band-bot.cjs") as {
  BtcPriceBandBot: new () => {
    start: () => void;
    snapshot: () => unknown;
  };
};

const router: IRouter = Router();
const bot = new BtcPriceBandBot();
bot.start();

router.get("/strategy/state", (_req, res) => {
  res.set("Cache-Control", "no-store").json(bot.snapshot());
});

export default router;
