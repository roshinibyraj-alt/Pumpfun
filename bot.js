// ============================================================
// pump.fun DEMO trending bot
// - Connects to a live pump.fun data feed (PumpPortal)
// - Watches every new token + every trade
// - Scores tokens against the rules in config.js
// - When a token crosses the thresholds, it logs a SIMULATED buy
//   (DEMO_MODE = true means: no real money, no real wallet, ever)
// ============================================================

const WebSocket = require("ws");
const config = require("./config.js");

// In-memory store: one entry per token mint address.
// { trades: [ {time, solAmount, buyer, isBuy} ... ], lastAlertTime: number }
const tokenActivity = new Map();

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}]`, ...args);
}

function getOrCreateToken(mint) {
  if (!tokenActivity.has(mint)) {
    tokenActivity.set(mint, { trades: [], lastAlertTime: 0, name: null, symbol: null });
  }
  return tokenActivity.get(mint);
}

function pruneOldTrades(entry, nowSec) {
  const cutoff = nowSec - config.WINDOW_SECONDS;
  entry.trades = entry.trades.filter((t) => t.time >= cutoff);
}

function scoreAndMaybeBuy(mint, entry, nowSec) {
  pruneOldTrades(entry, nowSec);

  const trades = entry.trades;
  const tradeCount = trades.length;
  const uniqueBuyers = new Set(trades.map((t) => t.buyer)).size;
  const solVolume = trades.reduce((sum, t) => sum + t.solAmount, 0);

  const meetsThreshold =
    tradeCount >= config.MIN_TRADES_IN_WINDOW &&
    uniqueBuyers >= config.MIN_UNIQUE_BUYERS_IN_WINDOW &&
    solVolume >= config.MIN_SOL_VOLUME_IN_WINDOW;

  if (!meetsThreshold) return;

  const secondsSinceLastAlert = nowSec - entry.lastAlertTime;
  if (secondsSinceLastAlert < config.COOLDOWN_SECONDS) return; // still cooling down

  entry.lastAlertTime = nowSec;

  simulateBuy(mint, entry, { tradeCount, uniqueBuyers, solVolume });
}

function simulateBuy(mint, entry, stats) {
  const label = entry.symbol || entry.name || mint;

  if (config.DEMO_MODE) {
    log("🟢 SIMULATED BUY (no real funds used)");
    log(`   Token: ${label}`);
    log(`   Mint address: ${mint}`);
    log(`   Fake spend: ${config.FAKE_BUY_SIZE_SOL} SOL`);
    log(
      `   Trigger stats: ${stats.tradeCount} trades / ${stats.uniqueBuyers} unique buyers / ${stats.solVolume.toFixed(
        2
      )} SOL volume in last ${config.WINDOW_SECONDS}s`
    );
    log(`   pump.fun link: https://pump.fun/${mint}`);
    log("---");
  } else {
    // Real-money execution is intentionally NOT implemented in this build.
    // Do not add a real buy here until you have tested demo mode extensively
    // and understand the risks.
    log("⚠️ DEMO_MODE is false but real-buy logic is not implemented. Doing nothing.");
  }
}

function connect() {
  log(`Connecting to ${config.WEBSOCKET_URL} ...`);
  const ws = new WebSocket(config.WEBSOCKET_URL);

  ws.on("open", () => {
    log("Connected. Subscribing to new token + trade streams...");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: ["all"] }));
    log(
      `Bot is live in ${config.DEMO_MODE ? "DEMO (paper trading)" : "REAL"} mode. Watching for trending coins...`
    );
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed messages
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // New token created
    if (msg.txType === "create" || msg.event_type === "create_coin") {
      const mint = msg.mint;
      if (!mint) return;
      const entry = getOrCreateToken(mint);
      entry.name = msg.name || entry.name;
      entry.symbol = msg.symbol || entry.symbol;
      log(`🆕 New token: ${entry.symbol || entry.name || mint} (${mint})`);
      return;
    }

    // Trade event (buy or sell)
    if (msg.txType === "buy" || msg.txType === "sell" || msg.method === "pumpFunTradeSubscribe") {
      const mint = msg.mint;
      if (!mint) return;
      const entry = getOrCreateToken(mint);

      entry.trades.push({
        time: nowSec,
        solAmount: Number(msg.solAmount || msg.sol_amount || 0),
        buyer: msg.traderPublicKey || msg.trader || msg.buyer || "unknown",
        isBuy: msg.txType === "buy",
      });

      scoreAndMaybeBuy(mint, entry, nowSec);
    }
  });

  ws.on("close", () => {
    log("Disconnected. Reconnecting in 5 seconds...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });
}

log("=== pump.fun DEMO trending bot starting ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
connect();
