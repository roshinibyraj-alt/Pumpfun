import { pool } from "@workspace/db";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PaperStateStore } = require("../src/bot/btc/paper-state-store.cjs");
const sourceUrl = process.env.BTC_5M_STATE_SOURCE_URL
  || "https://pumpfun-production-7acb.up.railway.app/api/strategy/state";

async function run() {
  const store = new PaperStateStore(pool);
  await store.initialize();
  const existing = await store.loadState();
  if (existing?.persistenceSource === "runtime") {
    console.log("BTC paper history already exists; keeping the durable ledger.");
    return;
  }
  if (existing) {
    console.log("Refreshing the pre-deploy BTC history snapshot from the live bot.");
  }

  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Could not read the live BTC paper ledger (${response.status}).`);
  }
  const snapshot = await response.json();
  const result = await store.seedFromPublicSnapshot(snapshot);
  if (!result.seeded) {
    console.log("BTC paper history was seeded by another process; keeping that ledger.");
    return;
  }
  console.log(`Seeded ${result.tradeCount} BTC paper records; cash $${result.cash}.`);
}

run()
  .catch(error => {
    console.error(`BTC paper history preparation failed: ${error?.message || "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
