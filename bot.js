// ============================================================
// pump.fun DEMO bot — MANUAL TOKENS ONLY
// - No automatic scanning or discovery of new tokens.
// - You add tokens by mint address via the dashboard.
// - For each token you add, the bot builds a rolling 1-minute
//   candle series and fits a linear regression channel (a real
//   trend line with top/bottom bands) from recent price history.
// - Buys the full 0.10 SOL position when price touches the
//   BOTTOM of the channel, sells the full position when price
//   touches the TOP, then keeps watching for the next bottom touch.
// - DEMO_MODE = true means: no real money, no real wallet, ever.
// - Serves a live dashboard so you can add/remove tokens and watch
//   everything happen, no coding needed.
// ============================================================

const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const config = require("./config.js");

// One entry per MANUALLY ADDED token mint address.
// { trades, name, symbol, lastMarketCapSol, addedAtSec, candles, currentCandle, lastAlertTime }
const tokenActivity = new Map();

// One entry per token mint address with an OPEN simulated position.
const openPositions = new Map();

let liveSocket = null;

const dashboardEvents = [];

const stats = {
  startedAt: new Date().toISOString(),
  connectionStatus: "connecting",
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

// ------------------------------------------------------------
// Robust price extraction — PumpPortal doesn't always include
// marketCapSol on every trade payload; fall back to computing an
// equivalent price proxy from bonding-curve reserves if needed.
// ------------------------------------------------------------
function extractPriceSol(msg) {
  if (msg.marketCapSol != null) return Number(msg.marketCapSol);
  if (msg.market_cap_sol != null) return Number(msg.market_cap_sol);
  const vSol = msg.vSolInBondingCurve;
  const vTokens = msg.vTokensInBondingCurve;
  if (vSol != null && vTokens != null && Number(vTokens) > 0) {
    // Not literally market cap, but a consistent price-proxy ratio that
    // moves the same way — fine for building a channel from.
    return (Number(vSol) / Number(vTokens)) * 1_000_000; // scaled for readable numbers
  }
  return null;
}

// ------------------------------------------------------------
// 1-minute candle building
// ------------------------------------------------------------
function updateCandle(entry, price, nowSec) {
  const bucket = Math.floor(nowSec / 60);
  if (!entry.currentCandle || entry.currentCandle.bucket !== bucket) {
    if (entry.currentCandle) {
      entry.candles.push(entry.currentCandle);
      if (entry.candles.length > config.MAX_CANDLES_STORED) {
        entry.candles.shift();
      }
    }
    entry.currentCandle = { bucket, open: price, high: price, low: price, close: price };
  } else {
    if (price > entry.currentCandle.high) entry.currentCandle.high = price;
    if (price < entry.currentCandle.low) entry.currentCandle.low = price;
    entry.currentCandle.close = price;
  }
}

// ------------------------------------------------------------
// Linear regression channel (the "trend line" with top/bottom bands)
// ------------------------------------------------------------
function computeChannel(entry) {
  const closes = entry.candles.map((c) => c.close);
  if (entry.currentCandle) closes.push(entry.currentCandle.close);

  const n = closes.length;
  if (n < config.MIN_CANDLES_FOR_CHANNEL) return null;

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += closes[i];
    sumXY += i * closes[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  let sumSqResid = 0;
  for (let i = 0; i < n; i++) {
    const yhat = slope * i + intercept;
    const resid = closes[i] - yhat;
    sumSqResid += resid * resid;
  }
  const stddev = Math.sqrt(sumSqResid / n);

  const latestX = n - 1;
  const trendValue = slope * latestX + intercept;
  const bottom = trendValue - config.CHANNEL_WIDTH_STDDEV * stddev;
  const top = trendValue + config.CHANNEL_WIDTH_STDDEV * stddev;

  return { slope, trendValue, bottom, top, stddev, candleCount: n };
}

// ------------------------------------------------------------
// Entry signal: buy when price touches the bottom of the channel
// ------------------------------------------------------------
function scoreAndMaybeBuy(mint, entry, nowSec) {
  if (openPositions.has(mint)) return; // already holding

  const secondsSinceLastAlert = nowSec - entry.lastAlertTime;
  if (secondsSinceLastAlert < config.COOLDOWN_SECONDS) return;

  const channel = computeChannel(entry);
  if (!channel) return; // not enough 1-minute candle history yet

  if (config.REQUIRE_NON_NEGATIVE_SLOPE && channel.slope < 0) return; // avoid a falling knife

  if (entry.lastMarketCapSol == null) return;

  if (entry.lastMarketCapSol <= channel.bottom) {
    entry.lastAlertTime = nowSec;
    simulateBuy(mint, entry, nowSec, channel);
  }
}

// ------------------------------------------------------------
// Open a simulated position
// ------------------------------------------------------------
function simulateBuy(mint, entry, nowSec, channel) {
  const label = entry.symbol || entry.name || mint;

  if (!config.DEMO_MODE) {
    log("DEMO_MODE is false but real-buy logic is not implemented. Doing nothing.");
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
    entryChannelBottom: channel.bottom,
    entryChannelTop: channel.top,
    entryTime: nowSec,
  });

  log(
    `BUY (channel bottom): ${label} (${mint}) - price ${entry.lastMarketCapSol.toFixed(4)} vs channel [${channel.bottom.toFixed(
      4
    )} - ${channel.top.toFixed(4)}] - spent ${config.FAKE_BUY_SIZE_SOL} SOL - balance now ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: "simulated_buy",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    fakeSpendSol: config.FAKE_BUY_SIZE_SOL,
    balanceAfterSol: stats.balanceSol,
    channelBottom: Number(channel.bottom.toFixed(6)),
    channelTop: Number(channel.top.toFixed(6)),
    link: `https://pump.fun/${mint}`,
  });
}

// ------------------------------------------------------------
// Sell the full position, realize simulated P/L
// ------------------------------------------------------------
function sellPosition(pos, currentMultiple, reasonType, mint, entry) {
  const solOut = pos.originalSolIn * currentMultiple;
  const pnl = solOut - pos.originalSolIn;

  stats.balanceSol = Number((stats.balanceSol + solOut).toFixed(6));
  stats.realizedPnlSol = Number((stats.realizedPnlSol + pnl).toFixed(6));

  const label = entry.symbol || entry.name || mint;
  log(
    `${reasonType.toUpperCase()}: ${label} sold 100% at ${currentMultiple.toFixed(2)}x - realized ${solOut.toFixed(
      4
    )} SOL (pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL) - balance ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: reasonType,
    mint,
    name: entry.name,
    symbol: entry.symbol,
    multiple: Number(currentMultiple.toFixed(3)),
    solOut: Number(solOut.toFixed(4)),
    pnlSol: Number(pnl.toFixed(4)),
    balanceAfterSol: stats.balanceSol,
    link: `https://pump.fun/${mint}`,
  });

  openPositions.delete(mint);
}

// ------------------------------------------------------------
// Manage an existing simulated position: channel-top exit, or safety stop
// ------------------------------------------------------------
function checkOpenPosition(mint, entry) {
  const pos = openPositions.get(mint);
  if (!pos) return;
  if (entry.lastMarketCapSol == null || !pos.entryMarketCapSol) return;

  const currentMultiple = entry.lastMarketCapSol / pos.entryMarketCapSol;

  if (config.SAFETY_STOP_LOSS_MULTIPLIER != null && currentMultiple <= config.SAFETY_STOP_LOSS_MULTIPLIER) {
    sellPosition(pos, currentMultiple, "safety_stop_loss", mint, entry);
    return;
  }

  const channel = computeChannel(entry);
  if (!channel) return;

  if (entry.lastMarketCapSol >= channel.top) {
    sellPosition(pos, currentMultiple, "channel_top_exit", mint, entry);
  }
}

// ------------------------------------------------------------
// Manual token add/remove
// ------------------------------------------------------------
function isValidMintFormat(mint) {
  return typeof mint === "string" && mint.length >= 32 && mint.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(mint);
}

function addToken(mint) {
  if (!isValidMintFormat(mint)) return { ok: false, error: "That doesn't look like a valid Solana mint address." };
  if (config.EXCLUDED_MINTS.includes(mint)) return { ok: false, error: "That's a known stablecoin/SOL mint, not a meme token." };
  if (tokenActivity.has(mint)) return { ok: false, error: "Already tracking that token." };
  if (tokenActivity.size >= config.MAX_TRACKED_TOKENS) {
    return { ok: false, error: `Max of ${config.MAX_TRACKED_TOKENS} tracked tokens reached. Remove one first.` };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  tokenActivity.set(mint, {
    trades: [],
    lastAlertTime: 0,
    name: null,
    symbol: null,
    lastMarketCapSol: null,
    addedAtSec: nowSec,
    candles: [],
    currentCandle: null,
  });

  if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
  }

  log(`MANUALLY ADDED: ${mint} - now building its 1-minute channel (needs ${config.MIN_CANDLES_FOR_CHANNEL}+ minutes of data)`);
  pushEvent({ type: "token_added", mint, link: `https://pump.fun/${mint}` });
  return { ok: true };
}

function removeToken(mint) {
  if (!tokenActivity.has(mint)) return { ok: false, error: "Not currently tracking that token." };

  const entry = tokenActivity.get(mint);
  const pos = openPositions.get(mint);
  if (pos && entry.lastMarketCapSol != null) {
    const currentMultiple = entry.lastMarketCapSol / pos.entryMarketCapSol;
    sellPosition(pos, currentMultiple, "manual_removal_exit", mint, entry);
  }

  if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
    liveSocket.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
  }
  tokenActivity.delete(mint);
  log(`REMOVED: ${mint}`);
  pushEvent({ type: "token_removed", mint, link: `https://pump.fun/${mint}` });
  return { ok: true };
}

// ------------------------------------------------------------
// WebSocket feed
// ------------------------------------------------------------
function connect() {
  const url = config.PUMPPORTAL_API_KEY
    ? `${config.WEBSOCKET_URL}?api-key=${config.PUMPPORTAL_API_KEY}`
    : config.WEBSOCKET_URL;

  if (!config.PUMPPORTAL_API_KEY) {
    log(
      "WARNING: No PUMPPORTAL_API_KEY set. Trade data will NOT arrive for any token you add " +
        "without a key tied to a wallet funded with at least 0.02 SOL. See README for setup steps."
    );
  }

  log(`Connecting to ${config.WEBSOCKET_URL} ...`);
  stats.connectionStatus = "connecting";
  const ws = new WebSocket(url);
  liveSocket = ws;

  ws.on("open", () => {
    log("Connected.");
    stats.connectionStatus = "connected";

    // Resubscribe to every manually tracked token after a reconnect.
    const mints = Array.from(tokenActivity.keys());
    if (mints.length > 0) {
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: mints }));
      log(`Resubscribed to ${mints.length} manually tracked token(s).`);
    }

    log(`Bot is live in ${config.DEMO_MODE ? "DEMO (paper trading)" : "REAL"} mode. Manual tokens only.`);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.txType !== "buy" && msg.txType !== "sell" && msg.method !== "pumpFunTradeSubscribe") return;

    const mint = msg.mint;
    if (!mint) return;
    const entry = tokenActivity.get(mint);
    if (!entry) return; // not a token we manually added - ignore

    const nowSec = Math.floor(Date.now() / 1000);

    entry.trades.push({
      time: nowSec,
      solAmount: Number(msg.solAmount || msg.sol_amount || 0),
      buyer: msg.traderPublicKey || msg.trader || msg.buyer || "unknown",
      isBuy: msg.txType === "buy",
    });
    stats.tradesProcessed += 1;

    if (msg.name && !entry.name) entry.name = msg.name;
    if (msg.symbol && !entry.symbol) entry.symbol = msg.symbol;

    const price = extractPriceSol(msg);
    if (price != null) {
      entry.lastMarketCapSol = price;
      updateCandle(entry, price, nowSec);
    } else if (entry.trades.length === 1) {
      // First trade ever received for this token and we still couldn't
      // find a usable price field - log once so this is diagnosable.
      log(`WARNING: received a trade for ${mint} but couldn't extract a price from it. Payload keys: ${Object.keys(msg).join(", ")}`);
    }

    checkOpenPosition(mint, entry);
    scoreAndMaybeBuy(mint, entry, nowSec);
  });

  ws.on("close", () => {
    stats.connectionStatus = "disconnected - reconnecting";
    liveSocket = null;
    log("Disconnected. Reconnecting in 5 seconds...");
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => {
    log("WebSocket error:", err.message);
  });

  // Heartbeat: every 60 seconds, print a one-line summary of every manually
  // tracked token so you can see channel status without opening the dashboard.
  // Also self-heals: if a token has received ZERO trades since being added
  // (e.g. the subscribe call landed in a brief disconnect window and was
  // silently dropped), resend its subscription rather than waiting for the
  // next full reconnect.
  const heartbeatInterval = setInterval(() => {
    log(
      `HEARTBEAT: ${stats.tradesProcessed} total trades processed | ${tokenActivity.size} manually tracked token(s) | ${openPositions.size} open position(s)`
    );
    for (const [mint, entry] of tokenActivity.entries()) {
      const label = entry.symbol || entry.name || mint;

      if (entry.trades.length === 0) {
        const secondsSinceAdded = Math.floor(Date.now() / 1000) - entry.addedAtSec;
        log(`  ${label}: NO TRADES RECEIVED YET (added ${secondsSinceAdded}s ago) - resending subscription`);
        if (liveSocket && liveSocket.readyState === WebSocket.OPEN) {
          liveSocket.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
        }
        continue;
      }

      const channel = computeChannel(entry);
      if (!channel) {
        log(`  ${label}: ${entry.trades.length} trades received | building history (${entry.candles.length + (entry.currentCandle ? 1 : 0)}/${config.MIN_CANDLES_FOR_CHANNEL} candles)`);
      } else {
        const pos = openPositions.get(mint);
        const status = pos ? "HOLDING" : "watching";
        log(
          `  ${label}: ${status} | price ${entry.lastMarketCapSol != null ? entry.lastMarketCapSol.toFixed(4) : "?"} | channel [${channel.bottom.toFixed(
            4
          )} - ${channel.top.toFixed(4)}] | slope ${channel.slope > 0 ? "up" : channel.slope < 0 ? "down" : "flat"}`
        );
      }
    }
  }, 60 * 1000);

  ws.on("close", () => clearInterval(heartbeatInterval));
}

// ------------------------------------------------------------
// Dashboard web server
// ------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

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
      currentMultiple: currentMultiple != null ? Number(currentMultiple.toFixed(3)) : null,
      entryChannelBottom: Number(pos.entryChannelBottom.toFixed(6)),
      entryChannelTop: Number(pos.entryChannelTop.toFixed(6)),
      link: `https://pump.fun/${mint}`,
    });
  }

  const tracked = [];
  for (const [mint, entry] of tokenActivity.entries()) {
    if (openPositions.has(mint)) continue; // shown in positions instead
    const channel = computeChannel(entry);
    const candleCount = entry.candles.length + (entry.currentCandle ? 1 : 0);
    let pctFromBottom = null;
    let slope = null;
    if (channel && entry.lastMarketCapSol != null) {
      pctFromBottom = Number((((entry.lastMarketCapSol - channel.bottom) / (channel.top - channel.bottom)) * 100).toFixed(1));
      slope = channel.slope > 0 ? "up" : channel.slope < 0 ? "down" : "flat";
    }
    tracked.push({
      mint,
      name: entry.name,
      symbol: entry.symbol,
      channelReady: !!channel,
      candleCount,
      candlesNeeded: config.MIN_CANDLES_FOR_CHANNEL,
      tradesReceived: entry.trades.length,
      pctFromBottom,
      slope,
      link: `https://pump.fun/${mint}`,
    });
  }

  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      FAKE_BUY_SIZE_SOL: config.FAKE_BUY_SIZE_SOL,
      CHANNEL_WIDTH_STDDEV: config.CHANNEL_WIDTH_STDDEV,
      MIN_CANDLES_FOR_CHANNEL: config.MIN_CANDLES_FOR_CHANNEL,
      REQUIRE_NON_NEGATIVE_SLOPE: config.REQUIRE_NON_NEGATIVE_SLOPE,
      COOLDOWN_SECONDS: config.COOLDOWN_SECONDS,
      SAFETY_STOP_LOSS_MULTIPLIER: config.SAFETY_STOP_LOSS_MULTIPLIER,
      MAX_TRACKED_TOKENS: config.MAX_TRACKED_TOKENS,
    },
    stats,
    positions,
    tracked,
    events: dashboardEvents,
  });
});

app.post("/api/add-token", (req, res) => {
  const mint = (req.body && req.body.mint || "").trim();
  const result = addToken(mint);
  res.json(result);
});

app.post("/api/remove-token", (req, res) => {
  const mint = (req.body && req.body.mint || "").trim();
  const result = removeToken(mint);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Dashboard server listening on port ${PORT}`);
});

log("=== pump.fun DEMO bot starting (MANUAL TOKENS ONLY) ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
log(`Starting demo balance: ${config.STARTING_BALANCE_SOL} SOL`);
log("No automatic scanning. Add tokens via the dashboard to start trading them.");
connect();
