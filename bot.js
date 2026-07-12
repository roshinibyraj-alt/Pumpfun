// ============================================================
// pump.fun DEMO trending bot + live web dashboard
// - Connects to a live pump.fun data feed (PumpPortal)
// - Watches every new token + every trade
// - Builds a rolling 1-minute candle series per token and fits a
//   linear regression channel (a real trend line with top/bottom
//   bands) from recent price history
// - Buys when price touches the BOTTOM of the channel, sells the
//   full position when price touches the TOP, then keeps watching
//   the same token for the next bottom touch
// - DEMO_MODE = true means: no real money, no real wallet, ever
// - Serves a live dashboard at your Railway URL so you can watch
//   everything in a browser, no coding needed.
// ============================================================

const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const config = require("./config.js");

// One entry per token mint address: recent trades, candles, price proxy.
const tokenActivity = new Map();

// One entry per token mint address with an OPEN simulated position.
// Closed positions are removed from here (not kept), so a token is free
// to trigger a fresh buy again the moment it next touches the channel bottom.
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
      createdAtSec: null,
      candles: [], // closed 1-minute candles: { bucket, open, high, low, close }
      currentCandle: null, // the candle still being built
    });
  }
  return tokenActivity.get(mint);
}

function pruneOldTrades(entry, nowSec) {
  const cutoff = nowSec - config.WINDOW_SECONDS;
  entry.trades = entry.trades.filter((t) => t.time >= cutoff);
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
  pruneOldTrades(entry, nowSec);

  // Don't stack a second position on a coin we're already holding.
  const existing = openPositions.get(mint);
  if (existing) return;

  // Core "don't snipe" rule: skip tokens outside the acceptable age window.
  if (entry.createdAtSec == null) return;
  const ageSeconds = nowSec - entry.createdAtSec;
  if (ageSeconds < config.MIN_TOKEN_AGE_SECONDS || ageSeconds > config.MAX_TOKEN_AGE_SECONDS) return;

  const secondsSinceLastAlert = nowSec - entry.lastAlertTime;
  if (secondsSinceLastAlert < config.COOLDOWN_SECONDS) return;

  // Baseline "is this token actually alive" check, before ever trusting a channel on it.
  const trades = entry.trades;
  const tradeCount = trades.length;
  const uniqueBuyers = new Set(trades.map((t) => t.buyer)).size;
  const solVolume = trades.reduce((sum, t) => sum + t.solAmount, 0);

  const minTrades = config.TEST_MODE ? config.TEST_MIN_TRADES_IN_WINDOW : config.MIN_TRADES_IN_WINDOW;
  const minBuyers = config.TEST_MODE ? config.TEST_MIN_UNIQUE_BUYERS_IN_WINDOW : config.MIN_UNIQUE_BUYERS_IN_WINDOW;
  const minVolume = config.TEST_MODE ? config.TEST_MIN_SOL_VOLUME_IN_WINDOW : config.MIN_SOL_VOLUME_IN_WINDOW;
  const isActiveEnough = tradeCount >= minTrades && uniqueBuyers >= minBuyers && solVolume >= minVolume;
  if (!isActiveEnough) return;

  const channel = computeChannel(entry);
  if (!channel) return; // not enough 1-minute candle history yet

  if (config.REQUIRE_NON_NEGATIVE_SLOPE && channel.slope < 0) return; // avoid a falling knife

  if (entry.lastMarketCapSol == null) return;

  if (entry.lastMarketCapSol <= channel.bottom) {
    entry.lastAlertTime = nowSec;
    simulateBuy(mint, entry, nowSec, { tradeCount, uniqueBuyers, solVolume, channel });
  }
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
    entryChannelBottom: tstats.channel.bottom,
    entryChannelTop: tstats.channel.top,
    entryTime: nowSec,
  });

  log(
    `BUY (channel bottom): ${label} (${mint}) - price ${entry.lastMarketCapSol.toFixed(4)} vs channel [${tstats.channel.bottom.toFixed(
      4
    )} - ${tstats.channel.top.toFixed(4)}] - spent ${config.FAKE_BUY_SIZE_SOL} SOL - balance now ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: "simulated_buy",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    fakeSpendSol: config.FAKE_BUY_SIZE_SOL,
    balanceAfterSol: stats.balanceSol,
    channelBottom: Number(tstats.channel.bottom.toFixed(6)),
    channelTop: Number(tstats.channel.top.toFixed(6)),
    tradeCount: tstats.tradeCount,
    uniqueBuyers: tstats.uniqueBuyers,
    solVolume: Number(tstats.solVolume.toFixed(3)),
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

  // Remove the position entirely (not just mark closed) so this token is
  // immediately free to trigger another buy the next time it touches the
  // channel bottom.
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

  // Safety backstop first: exit regardless of the channel if things have
  // truly collapsed. This is NOT a trading signal, just a circuit breaker.
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
// WebSocket feed
// ------------------------------------------------------------
function connect() {
  const url = config.PUMPPORTAL_API_KEY
    ? `${config.WEBSOCKET_URL}?api-key=${config.PUMPPORTAL_API_KEY}`
    : config.WEBSOCKET_URL;

  if (!config.PUMPPORTAL_API_KEY) {
    log(
      "WARNING: No PUMPPORTAL_API_KEY set. Token-creation events will still work, " +
        "but trade data (needed to trigger any buy) will NOT arrive without a key " +
        "tied to a wallet funded with at least 0.02 SOL. See README for setup steps."
    );
  }

  log(`Connecting to ${config.WEBSOCKET_URL} ...`);
  stats.connectionStatus = "connecting";
  const ws = new WebSocket(url);

  ws.on("open", () => {
    log("Connected. Subscribing to new token creation stream...");
    stats.connectionStatus = "connected";
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
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
      if (!mint || config.EXCLUDED_MINTS.includes(mint)) return;
      const entry = getOrCreateToken(mint);
      entry.name = msg.name || entry.name;
      entry.symbol = msg.symbol || entry.symbol;
      entry.createdAtSec = nowSec;
      if (msg.marketCapSol != null) {
        entry.lastMarketCapSol = Number(msg.marketCapSol);
        updateCandle(entry, entry.lastMarketCapSol, nowSec);
      }
      stats.newTokensSeen += 1;

      // Subscribe to live trades for THIS specific token now that we know its
      // mint address. This is required — PumpPortal has no "subscribe to
      // every trade platform-wide" option, only per-token subscriptions.
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));

      log(`New token: ${entry.symbol || entry.name || mint} (${mint}) - subscribed to its trades`);
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
      if (!mint || config.EXCLUDED_MINTS.includes(mint)) return;
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
      if (msg.name && !entry.name) entry.name = msg.name;
      if (msg.symbol && !entry.symbol) entry.symbol = msg.symbol;

      if (msg.marketCapSol != null) {
        entry.lastMarketCapSol = Number(msg.marketCapSol);
        updateCandle(entry, entry.lastMarketCapSol, nowSec);
      }

      // Manage any existing position on every price update (channel-top exit
      // or safety stop), then check whether this trade creates a fresh
      // bottom-of-channel buy signal.
      checkOpenPosition(mint, entry);
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

  // Periodically drop tokens that have gone quiet (no trades for a while)
  // and have no open position, so we don't stay subscribed to every dead
  // token forever.
  const cleanupInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleCutoff = nowSec - 30 * 60; // 30 minutes of silence = stale
    for (const [mint, entry] of tokenActivity.entries()) {
      const hasActivePosition = openPositions.has(mint);
      const lastTradeTime = entry.trades.length ? entry.trades[entry.trades.length - 1].time : entry.lastAlertTime;
      const isStale = lastTradeTime < staleCutoff && entry.lastAlertTime < staleCutoff;
      if (isStale && !hasActivePosition) {
        ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
        tokenActivity.delete(mint);
      }
    }
  }, 5 * 60 * 1000);

  ws.on("close", () => clearInterval(cleanupInterval));

  // Heartbeat: every 60 seconds, print a one-line summary + the most active
  // tracked tokens right now, so you can SEE whether trade data is flowing
  // in without waiting blindly for a buy to happen.
  const heartbeatInterval = setInterval(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const ranked = [];
    for (const [mint, entry] of tokenActivity.entries()) {
      pruneOldTrades(entry, nowSec);
      if (entry.trades.length === 0) continue;
      const channel = computeChannel(entry);
      ranked.push({
        label: entry.symbol || entry.name || mint,
        trades: entry.trades.length,
        buyers: new Set(entry.trades.map((t) => t.buyer)).size,
        volume: entry.trades.reduce((s, t) => s + t.solAmount, 0),
        channelReady: !!channel,
      });
    }
    ranked.sort((a, b) => b.trades - a.trades);

    log(
      `HEARTBEAT: ${stats.tradesProcessed} total trades processed | ${tokenActivity.size} tokens tracked | ${ranked.length} with recent activity | ${openPositions.size} open positions`
    );
    if (ranked.length === 0) {
      log(
        "HEARTBEAT: no tokens have any trade data yet. If this persists, trade subscription isn't delivering data (check API key)."
      );
    } else {
      ranked.slice(0, 5).forEach((r) => {
        log(
          `  ${r.label}: ${r.trades} trades / ${r.buyers} buyers / ${r.volume.toFixed(2)} SOL in window / channel ${
            r.channelReady ? "ready" : "still building"
          }`
        );
      });
    }
  }, 60 * 1000);

  ws.on("close", () => clearInterval(heartbeatInterval));
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
      currentMultiple: currentMultiple != null ? Number(currentMultiple.toFixed(3)) : null,
      entryChannelBottom: Number(pos.entryChannelBottom.toFixed(6)),
      entryChannelTop: Number(pos.entryChannelTop.toFixed(6)),
      link: `https://pump.fun/${mint}`,
    });
  }

  // Tokens currently being tracked for a channel-bottom touch (active, aging
  // requirement met, channel computed, no open position yet).
  const tracking = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [mint, entry] of tokenActivity.entries()) {
    if (openPositions.has(mint)) continue;
    if (entry.createdAtSec == null) continue;
    const ageSeconds = nowSec - entry.createdAtSec;
    if (ageSeconds < config.MIN_TOKEN_AGE_SECONDS || ageSeconds > config.MAX_TOKEN_AGE_SECONDS) continue;
    const channel = computeChannel(entry);
    if (!channel) continue;
    if (entry.lastMarketCapSol == null) continue;
    const pctFromBottom = ((entry.lastMarketCapSol - channel.bottom) / (channel.top - channel.bottom)) * 100;
    tracking.push({
      mint,
      name: entry.name,
      symbol: entry.symbol,
      slope: channel.slope > 0 ? "up" : channel.slope < 0 ? "down" : "flat",
      pctFromBottom: Number(pctFromBottom.toFixed(1)),
      link: `https://pump.fun/${mint}`,
    });
  }
  tracking.sort((a, b) => a.pctFromBottom - b.pctFromBottom);

  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      FAKE_BUY_SIZE_SOL: config.FAKE_BUY_SIZE_SOL,
      MIN_TOKEN_AGE_SECONDS: config.MIN_TOKEN_AGE_SECONDS,
      MAX_TOKEN_AGE_SECONDS: config.MAX_TOKEN_AGE_SECONDS,
      CHANNEL_WIDTH_STDDEV: config.CHANNEL_WIDTH_STDDEV,
      MIN_CANDLES_FOR_CHANNEL: config.MIN_CANDLES_FOR_CHANNEL,
      REQUIRE_NON_NEGATIVE_SLOPE: config.REQUIRE_NON_NEGATIVE_SLOPE,
      WINDOW_SECONDS: config.WINDOW_SECONDS,
      MIN_TRADES_IN_WINDOW: config.MIN_TRADES_IN_WINDOW,
      MIN_UNIQUE_BUYERS_IN_WINDOW: config.MIN_UNIQUE_BUYERS_IN_WINDOW,
      MIN_SOL_VOLUME_IN_WINDOW: config.MIN_SOL_VOLUME_IN_WINDOW,
      COOLDOWN_SECONDS: config.COOLDOWN_SECONDS,
      SAFETY_STOP_LOSS_MULTIPLIER: config.SAFETY_STOP_LOSS_MULTIPLIER,
    },
    stats,
    positions,
    tracking,
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
log(`Strategy: buy at channel bottom, sell at channel top (${config.CHANNEL_WIDTH_STDDEV} stddev, ${config.MIN_CANDLES_FOR_CHANNEL}+ candles required)`);
connect();
