// ============================================================
// pump.fun DEMO trending bot + live web dashboard
// - Connects to a live pump.fun data feed (PumpPortal)
// - Watches every new token + every trade
// - Scores tokens against the rules in config.js
// - When a token crosses the thresholds, it logs a SIMULATED buy
//   (DEMO_MODE = true means: no real money, no real wallet, ever)
// - Serves a live dashboard at your Railway URL so you can watch
//   everything in a browser, no coding needed.
// ============================================================

const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const config = require("./config.js");

// In-memory store: one entry per token mint address.
const tokenActivity = new Map();

// Rolling list of events shown on the dashboard (newest first).
const dashboardEvents = [];

// Running stats shown at the top of the dashboard.
const stats = {
  startedAt: new Date().toISOString(),
  connectionStatus: "connecting",
  newTokensSeen: 0,
  simulatedBuys: 0,
  tradesProcessed: 0,
};

function log(...args) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}]`, ...args);
}

function pushEvent(event) {
  dashboardEvents.unshift({ time: new Date().toISOString(), ...event });
  if (dashboardEvents.length > config.MAX_DASHBOARD_EVENTS) {
    dashboardEvents.length = config.MAX_DASHBOARD_EVENTS;
  }
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

function simulateBuy(mint, entry, tstats) {
  const label = entry.symbol || entry.name || mint;

  if (config.DEMO_MODE) {
    stats.simulatedBuys += 1;
    log(`SIMULATED BUY: ${label} (${mint})`);
    pushEvent({
      type: "simulated_buy",
      mint,
      name: entry.name,
      symbol: entry.symbol,
      fakeSpendSol: config.FAKE_BUY_SIZE_SOL,
      tradeCount: tstats.tradeCount,
      uniqueBuyers: tstats.uniqueBuyers,
      solVolume: Number(tstats.solVolume.toFixed(3)),
      link: `https://pump.fun/${mint}`,
    });
  } else {
    log("DEMO_MODE is false but real-buy logic is not implemented. Doing nothing.");
  }
}

function connect() {
  log(`Connecting to ${config.WEBSOCKET_URL} ...`);
  stats.connectionStatus = "connecting";
  const ws = new WebSocket(config.WEBSOCKET_URL);

  ws.on("open", () => {
    log("Connected. Subscribing to new token + trade streams...");
    stats.connectionStatus = "connected";
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: ["all"] }));
    log(`Bot is live in ${config.DEMO_MODE ? "DEMO (paper trading)" : "REAL"} mode.`);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    if (msg.txType === "create" || msg.event_type === "create_coin") {
      const mint = msg.mint;
      if (!mint) return;
      const entry = getOrCreateToken(mint);
      entry.name = msg.name || entry.name;
      entry.symbol = msg.symbol || entry.symbol;
      stats.newTokensSeen += 1;
      log(`New token: ${entry.symbol || entry.name || mint} (${mint})`);
      pushEvent({
        type: "new_token",
        mint,
        name: entry.name,
        symbol: entry.symbol,
        link: `https://pump.fun/${mint}`,
      });
      return;
    }

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
      stats.tradesProcessed += 1;

      scoreAndMaybeBuy(mint, entry, nowSec);
    }
  });

  ws.on("close", () => {
    stats.connectionStatus = "disconnected - reconnecting";
    log("Disconnected. Reconnecting in 5 seconds...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });
}

// ------------------------------------------------------------
// Dashboard web server
// ------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/state", (req, res) => {
  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      FAKE_BUY_SIZE_SOL: config.FAKE_BUY_SIZE_SOL,
      WINDOW_SECONDS: config.WINDOW_SECONDS,
      MIN_TRADES_IN_WINDOW: config.MIN_TRADES_IN_WINDOW,
      MIN_UNIQUE_BUYERS_IN_WINDOW: config.MIN_UNIQUE_BUYERS_IN_WINDOW,
      MIN_SOL_VOLUME_IN_WINDOW: config.MIN_SOL_VOLUME_IN_WINDOW,
      COOLDOWN_SECONDS: config.COOLDOWN_SECONDS,
    },
    stats,
    events: dashboardEvents,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Dashboard server listening on port ${PORT}`);
});

log("=== pump.fun DEMO trending bot starting ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
connect();
