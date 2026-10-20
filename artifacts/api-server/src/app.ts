import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { existsSync } from "node:fs";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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
    path.resolve(process.cwd(), "public/btc.html"),
    path.resolve(process.cwd(), "artifacts/api-server/public/btc.html"),
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

const webDistPath = path.resolve(
  process.cwd(),
  "../btc-signal-accumulator/dist/public",
);
app.use(express.static(webDistPath));

export default app;
