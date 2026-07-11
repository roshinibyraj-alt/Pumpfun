// ============================================================
// pump.fun DEMO trending bot + live web dashboard
// - Connects to a live pump.fun data feed (PumpPortal)
// - Watches every new token + every trade
// - Scores tokens against the rules in config.js
// - When a token crosses the thresholds, it SIMULATES a buy
//   (DEMO_MODE = true means: no real money, no real wallet, ever)
// - Manages each simulated position with a take-profit +
//   trailing-stop + stop-loss exit strategy (see config.js)
// - Serves a live dashboard at your Railway URL so you can watch
//   everything in a browser, no coding needed.
// ============================================================

const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const config = require("./config.js");

// One entry per token mint address: recent trades + rolling market-cap price proxy.
const tokenActivity = new Map();

// One entry per token mint address WITH AN ACTIVE OR CLOSED SIMULATED POSITION.
const openPositions = new Map();

// Rolling list of events shown on the dashboard (newest first).
const dashboardEvents = [];

const stats = {
  startedAt: new Date().toISOString(),
  connectionStatus: "connecting",
  newTokensSeen: 0,
  simulatedBuys: 0,
  tradesProcessed: 0,
  startingBalanceSol: config.STARTING_BALANCE_SOL,
  balanceSol: config.STARTING_BALANCE_SOL,
  totalSpentSol: 0,
  realizedPnlSol: 0,
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
    tokenActivity.set(mint, {
      trades: [],
      lastAlertTime: 0,
      name: null,
      symbol: null,
      lastMarketCapSol: null,
    });
  }
  return tokenActivity.get(mint);
}

function pruneOldTrades(entry, nowSec) {
  const cutoff = nowSec - config.WINDOW_SECONDS;
  entry.trades = entry.trades.filter((t) => t.time >= cutoff);
}

// ------------------------------------------------------------
// Entry signal: decide whether to open a new simulated position
// ------------------------------------------------------------
function scoreAndMaybeBuy(mint, entry, nowSec) {
  pruneOldTrades(entry, nowSec);

  // Don't stack a second position on a coin we're already holding.
  const existing = openPositions.get(mint);
  if (existing && existing.state !== "closed") return;

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

  simulateBuy(mint, entry, nowSec, { tradeCount, uniqueBuyers, solVolume });
}

// ------------------------------------------------------------
// Open a simulated position
// ------------------------------------------------------------
function simulateBuy(mint, entry, nowSec, tstats) {
  const label = entry.symbol || entry.name || mint;

  if (!config.DEMO_MODE) {
    log("DEMO_MODE is false but real-buy logic is not implemented. Doing nothing.");
    return;
  }

  if (entry.lastMarketCapSol == null) {
    log(`SKIPPED (no price data yet): ${label}`);
    return;
  }

  if (stats.balanceSol < config.FAKE_BUY_SIZE_SOL) {
    log(`SKIPPED (out of demo balance): ${label} - balance is ${stats.balanceSol.toFixed(3)} SOL`);
    pushEvent({
      type: "skipped_low_balance",
      mint,
      name: entry.name,
      symbol: entry.symbol,
      balanceSol: Number(stats.balanceSol.toFixed(3)),
    });
    return;
  }

  stats.simulatedBuys += 1;
  stats.balanceSol = Number((stats.balanceSol - config.FAKE_BUY_SIZE_SOL).toFixed(6));
  stats.totalSpentSol = Number((stats.totalSpentSol + config.FAKE_BUY_SIZE_SOL).toFixed(6));

  openPositions.set(mint, {
    symbol: entry.symbol,
    name: entry.name,
    entryMarketCapSol: entry.lastMarketCapSol,
    originalSolIn: config.FAKE_BUY_SIZE_SOL,
    costBasisRemaining: config.FAKE_BUY_SIZE_SOL,
    tokensFractionRemaining: 1,
    state: "open", // open -> half_sold -> closed
    highWaterMultiple: 1,
    entryTime: nowSec,
  });

  log(`SIMULATED BUY: ${label} (${mint}) - spent ${config.FAKE_BUY_SIZE_SOL} SOL - balance now ${stats.balanceSol} SOL`);
  pushEvent({
    type: "simulated_buy",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    fakeSpendSol: config.FAKE_BUY_SIZE_SOL,
    balanceAfterSol: stats.balanceSol,
    tradeCount: tstats.tradeCount,
    uniqueBuyers: tstats.uniqueBuyers,
    solVolume: Number(tstats.solVolume.toFixed(3)),
    link: `https://pump.fun/${mint}`,
  });
}

// ------------------------------------------------------------
// Sell some fraction of a position, realize simulated P/L
// ------------------------------------------------------------
function sellFraction(pos, fraction, currentMultiple, reasonType, mint, entry) {
  const costBasisSold = pos.originalSolIn * fraction;
  const solOut = pos.originalSolIn * fraction * currentMultiple;
  const pnl = solOut - costBasisSold;

  stats.balanceSol = Number((stats.balanceSol + solOut).toFixed(6));
  stats.realizedPnlSol = Number((stats.realizedPnlSol + pnl).toFixed(6));
  pos.tokensFractionRemaining = Number((pos.tokensFractionRemaining - fraction).toFixed(6));
  pos.costBasisRemaining = Number((pos.costBasisRemaining - costBasisSold).toFixed(6));

  const label = entry.symbol || entry.name || mint;
  log(
    `${reasonType.toUpperCase()}: ${label} sold ${(fraction * 100).toFixed(0)}% at ${currentMultiple.toFixed(
      2
    )}x - realized ${solOut.toFixed(4)} SOL (pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL) - balance ${
      stats.balanceSol
    } SOL`
  );

  pushEvent({
    type: reasonType,
    mint,
    name: entry.name,
    symbol: entry.symbol,
    multiple: Number(currentMultiple.toFixed(3)),
    soldFractionPct: Math.round(fraction * 100),
    solOut: Number(solOut.toFixed(4)),
    pnlSol: Number(pnl.toFixed(4)),
    balanceAfterSol: stats.balanceSol,
    link: `https://pump.fun/${mint}`,
  });
}

// ------------------------------------------------------------
// Manage an existing simulated position: TP1 / trailing stop / stop loss
// ------------------------------------------------------------
function checkOpenPosition(mint, entry) {
  const pos = openPositions.get(mint);
  if (!pos || pos.state === "closed") return;
  if (entry.lastMarketCapSol == null || !pos.entryMarketCapSol) return;

  const currentMultiple = entry.lastMarketCapSol / pos.entryMarketCapSol;

  if (pos.state === "open") {
    if (currentMultiple >= config.TP1_MULTIPLIER) {
      sellFraction(pos, 0.5, currentMultiple, "tp1_hit", mint, entry);
      pos.state = "half_sold";
      pos.highWaterMultiple = currentMultiple;
    } else if (currentMultiple <= config.STOP_LOSS_MULTIPLIER) {
      sellFraction(pos, pos.tokensFractionRemaining, currentMultiple, "stop_loss", mint, entry);
      pos.state = "closed";
    }
  } else if (pos.state === "half_sold") {
    if (currentMultiple > pos.highWaterMultiple) pos.highWaterMultiple = currentMultiple;
    const trailingLevel = pos.highWaterMultiple * (1 - config.TRAILING_STOP_PCT);
    if (currentMultiple <= trailingLevel) {
      sellFraction(pos, pos.tokensFractionRemaining, currentMultiple, "trailing_stop_exit", mint, entry);
      pos.state = "closed";
    }
  }
}

// ------------------------------------------------------------
// WebSocket feed
// ------------------------------------------------------------
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
      if (msg.marketCapSol != null) entry.lastMarketCapSol = Number(msg.marketCapSol);
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

      // Trade payloads sometimes carry name/symbol even for tokens created
      // before this bot connected (so we never saw their "create" event).
      // Grab it here too so older tokens still display with a real ticker
      // instead of just a raw mint address.
      if (msg.name && !entry.name) entry.name = msg.name;
      if (msg.symbol && !entry.symbol) entry.symbol = msg.symbol;

      if (msg.marketCapSol != null) {
        entry.lastMarketCapSol = Number(msg.marketCapSol);
      }

      // Manage any existing position on every price update, regardless of window.
      checkOpenPosition(mint, entry);

      // Then check whether this trade pushes the token over the entry threshold.
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
  const positions = [];
  for (const [mint, pos] of openPositions.entries()) {
    const entry = tokenActivity.get(mint);
    const currentMarketCapSol = entry ? entry.lastMarketCapSol : null;
    const currentMultiple =
      currentMarketCapSol != null && pos.entryMarketCapSol ? currentMarketCapSol / pos.entryMarketCapSol : null;
    positions.push({
      mint,
      name: pos.name,
      symbol: pos.symbol,
      state: pos.state,
      tokensFractionRemaining: pos.tokensFractionRemaining,
      currentMultiple: currentMultiple != null ? Number(currentMultiple.toFixed(3)) : null,
      highWaterMultiple: Number(pos.highWaterMultiple.toFixed(3)),
      link: `https://pump.fun/${mint}`,
    });
  }
  // Show open/half_sold positions first, most recently entered first.
  positions.sort((a, b) => (a.state === "closed") - (b.state === "closed"));

  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      FAKE_BUY_SIZE_SOL: config.FAKE_BUY_SIZE_SOL,
      WINDOW_SECONDS: config.WINDOW_SECONDS,
      MIN_TRADES_IN_WINDOW: config.MIN_TRADES_IN_WINDOW,
      MIN_UNIQUE_BUYERS_IN_WINDOW: config.MIN_UNIQUE_BUYERS_IN_WINDOW,
      MIN_SOL_VOLUME_IN_WINDOW: config.MIN_SOL_VOLUME_IN_WINDOW,
      COOLDOWN_SECONDS: config.COOLDOWN_SECONDS,
      TP1_MULTIPLIER: config.TP1_MULTIPLIER,
      TRAILING_STOP_PCT: config.TRAILING_STOP_PCT,
      STOP_LOSS_MULTIPLIER: config.STOP_LOSS_MULTIPLIER,
    },
    stats,
    positions,
    events: dashboardEvents,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Dashboard server listening on port ${PORT}`);
});

log("=== pump.fun DEMO trending bot starting ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
log(`Starting demo balance: ${config.STARTING_BALANCE_SOL} SOL`);
connect();
