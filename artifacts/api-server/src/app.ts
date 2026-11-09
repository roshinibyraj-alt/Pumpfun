import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { existsSync } from "node:fs";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
const LIVE_BALANCE_URL =
  "https://polymarket-btc-5m-bot-production.up.railway.app/api/live-balance";
let liveBalanceCache:
  | { cachedAt: number; value: Record<string, unknown> }
  | undefined;
let liveBalanceRequest: Promise<Record<string, unknown>> | undefined;

async function getLiveBalanceSummary(): Promise<Record<string, unknown>> {
  if (liveBalanceCache && Date.now() - liveBalanceCache.cachedAt < 10_000) {
    return liveBalanceCache.value;
  }
  if (!liveBalanceRequest) {
    liveBalanceRequest = fetch(LIVE_BALANCE_URL, {
      signal: AbortSignal.timeout(8_000),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Live balance service returned ${response.status}`);
        }
        const body = (await response.json()) as Record<string, unknown>;
        const value = {
          status: body.status,
          accountReady: body.accountReady,
          collateral: body.collateral,
          positionValue: body.positionValue,
          equity: body.equity,
          positionCount: body.positionCount,
          asOf: body.asOf,
          error: body.error,
        };
        liveBalanceCache = { cachedAt: Date.now(), value };
        return value;
      })
      .finally(() => {
        liveBalanceRequest = undefined;
      });
  }
  return liveBalanceRequest;
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.get("/", (_req, res, next) => {
  const dashboardPath = [
    path.resolve(process.cwd(), "public/cross-pair.html"),
    path.resolve(process.cwd(), "artifacts/api-server/public/cross-pair.html"),
    path.resolve(process.cwd(), "public/probability.html"),
    path.resolve(process.cwd(), "artifacts/api-server/public/probability.html"),
  ].find(existsSync);
  if (!dashboardPath) {
    next();
    return;
  }
  res.set("Cache-Control", "no-store");
  res.sendFile(
    dashboardPath,
    (error) => {
      if (error) next(error);
    },
  );
});

app.get("/api/real-balance", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await getLiveBalanceSummary());
  } catch {
    res.status(503).json({
      status: "unavailable",
      collateral: null,
      positionValue: null,
      equity: null,
      asOf: null,
    });
  }
});

const webDistPath = path.resolve(
  process.cwd(),
  "../btc-signal-accumulator/dist/public",
);
app.use(express.static(webDistPath));

export default app;
