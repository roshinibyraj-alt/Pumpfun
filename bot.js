// ============================================================
// pump.fun DEMO bot — MANUAL TOKENS ONLY, price via DexScreener
// - No automatic scanning or discovery of new tokens.
// - You add tokens by mint address via the dashboard.
// - Price data comes from DexScreener's free public REST API —
//   no key, no wallet, no metering cost. The bot polls it on an
//   interval and builds its own 1-minute candles from the results.
// - For each token, fits a linear regression channel (a real trend
//   line with top/bottom bands) from recent price history.
// - Buys the full 0.10 SOL position when price touches the BOTTOM
//   of the channel, sells the full position when price touches the
//   TOP, then keeps watching for the next bottom touch.
// - DEMO_MODE = true means: no real money, no real wallet, ever.
// ============================================================

const express = require("express");
const path = require("path");
const config = require("./config.js");

// One entry per MANUALLY ADDED token mint address.
// { name, symbol, lastPriceSol, lastUpdatedSec, addedAtSec, candles, currentCandle, lastAlertTime }
const tokenActivity = new Map();

// One entry per token mint address with an OPEN simulated position.
const openPositions = new Map();

const dashboardEvents = [];

const stats = {
  startedAt: new Date().toISOString(),
  lastPollStatus: "not yet polled",
  lastPollAt: null,
  simulatedBuys: 0,
  pricePollsCompleted: 0,
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
  if (openPositions.has(mint)) return;

  const secondsSinceLastAlert = nowSec - entry.lastAlertTime;
  if (secondsSinceLastAlert < config.COOLDOWN_SECONDS) return;

  const channel = computeChannel(entry);
  if (!channel) return;

  if (config.REQUIRE_NON_NEGATIVE_SLOPE && channel.slope < 0) return;

  if (entry.lastPriceSol == null) return;

  if (entry.lastPriceSol <= channel.bottom) {
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
    pushEvent({ type: "skipped_low_balance", mint, name: entry.name, symbol: entry.symbol, balanceSol: Number(stats.balanceSol.toFixed(3)) });
    return;
  }

  stats.simulatedBuys += 1;
  stats.balanceSol = Number((stats.balanceSol - config.FAKE_BUY_SIZE_SOL).toFixed(6));
  stats.totalSpentSol = Number((stats.totalSpentSol + config.FAKE_BUY_SIZE_SOL).toFixed(6));

  openPositions.set(mint, {
    symbol: entry.symbol,
    name: entry.name,
    entryPriceSol: entry.lastPriceSol,
    originalSolIn: config.FAKE_BUY_SIZE_SOL,
    entryChannelBottom: channel.bottom,
    entryChannelTop: channel.top,
    entryTime: nowSec,
  });

  log(
    `BUY (channel bottom): ${label} (${mint}) - price ${entry.lastPriceSol} vs channel [${channel.bottom.toFixed(8)} - ${channel.top.toFixed(
      8
    )}] - spent ${config.FAKE_BUY_SIZE_SOL} SOL - balance now ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: "simulated_buy",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    fakeSpendSol: config.FAKE_BUY_SIZE_SOL,
    balanceAfterSol: stats.balanceSol,
    channelBottom: channel.bottom,
    channelTop: channel.top,
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
    `${reasonType.toUpperCase()}: ${label} sold 100% at ${currentMultiple.toFixed(2)}x - realized ${solOut.toFixed(4)} SOL (pnl ${
      pnl >= 0 ? "+" : ""
    }${pnl.toFixed(4)} SOL) - balance ${stats.balanceSol} SOL`
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
  if (entry.lastPriceSol == null || !pos.entryPriceSol) return;

  const currentMultiple = entry.lastPriceSol / pos.entryPriceSol;

  if (config.SAFETY_STOP_LOSS_MULTIPLIER != null && currentMultiple <= config.SAFETY_STOP_LOSS_MULTIPLIER) {
    sellPosition(pos, currentMultiple, "safety_stop_loss", mint, entry);
    return;
  }

  const channel = computeChannel(entry);
  if (!channel) return;

  if (entry.lastPriceSol >= channel.top) {
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
    name: null,
    symbol: null,
    lastPriceSol: null,
    lastUpdatedSec: null,
    addedAtSec: nowSec,
    lastAlertTime: 0,
    candles: [],
    currentCandle: null,
  });

  log(`MANUALLY ADDED: ${mint} - fetching price from DexScreener (needs ~${config.MIN_CANDLES_FOR_CHANNEL} minutes of history before it can trade)`);
  pushEvent({ type: "token_added", mint, link: `https://pump.fun/${mint}` });

  // Kick off an immediate poll just for this token so it doesn't wait for the next cycle.
  pollTokens([mint]).catch((err) => log("Immediate poll for new token failed:", err.message));

  return { ok: true };
}

function removeToken(mint) {
  if (!tokenActivity.has(mint)) return { ok: false, error: "Not currently tracking that token." };

  const entry = tokenActivity.get(mint);
  const pos = openPositions.get(mint);
  if (pos && entry.lastPriceSol != null) {
    const currentMultiple = entry.lastPriceSol / pos.entryPriceSol;
    sellPosition(pos, currentMultiple, "manual_removal_exit", mint, entry);
  }

  tokenActivity.delete(mint);
  log(`REMOVED: ${mint}`);
  pushEvent({ type: "token_removed", mint, link: `https://pump.fun/${mint}` });
  return { ok: true };
}

// ------------------------------------------------------------
// DexScreener polling
// ------------------------------------------------------------
function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function pollTokens(mints) {
  if (mints.length === 0) return;

  for (const batch of chunk(mints, 30)) {
    const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`;
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      stats.lastPollStatus = `network error: ${err.message}`;
      log(`DexScreener poll failed (network): ${err.message}`);
      continue;
    }

    if (!res.ok) {
      stats.lastPollStatus = `HTTP ${res.status}`;
      log(`DexScreener poll failed: HTTP ${res.status}`);
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      stats.lastPollStatus = "bad JSON response";
      continue;
    }

    const pairs = Array.isArray(data) ? data : Array.isArray(data.pairs) ? data.pairs : [];

    // For each mint, pick the pair with the highest USD liquidity (its most active market).
    const bestPairByMint = new Map();
    for (const pair of pairs) {
      const baseAddr = pair.baseToken && pair.baseToken.address;
      if (!baseAddr || !tokenActivity.has(baseAddr)) continue;
      const liquidity = (pair.liquidity && pair.liquidity.usd) || 0;
      const existing = bestPairByMint.get(baseAddr);
      if (!existing || liquidity > existing._liquidity) {
        bestPairByMint.set(baseAddr, { ...pair, _liquidity: liquidity });
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    for (const mint of batch) {
      const entry = tokenActivity.get(mint);
      if (!entry) continue;
      const pair = bestPairByMint.get(mint);
      if (!pair) continue; // no pair found yet for this token on DexScreener

      if (pair.baseToken.name && !entry.name) entry.name = pair.baseToken.name;
      if (pair.baseToken.symbol && !entry.symbol) entry.symbol = pair.baseToken.symbol;

      const price = parseFloat(pair.priceNative);
      if (!Number.isFinite(price)) continue;

      entry.lastPriceSol = price;
      entry.lastUpdatedSec = nowSec;
      updateCandle(entry, price, nowSec);

      checkOpenPosition(mint, entry);
      scoreAndMaybeBuy(mint, entry, nowSec);
    }

    stats.lastPollStatus = "ok";
  }

  stats.pricePollsCompleted += 1;
  stats.lastPollAt = new Date().toISOString();
}

function startPolling() {
  const intervalMs = config.DEXSCREENER_POLL_INTERVAL_SECONDS * 1000;
  setInterval(() => {
    const mints = Array.from(tokenActivity.keys());
    if (mints.length === 0) return;
    pollTokens(mints).catch((err) => log("Poll cycle failed:", err.message));
  }, intervalMs);

  // Heartbeat every 60s summarizing tracked tokens.
  setInterval(() => {
    log(`HEARTBEAT: ${tokenActivity.size} tracked token(s) | ${openPositions.size} open position(s) | last poll: ${stats.lastPollStatus}`);
    for (const [mint, entry] of tokenActivity.entries()) {
      const label = entry.symbol || entry.name || mint;
      if (entry.lastPriceSol == null) {
        log(`  ${label}: no price data yet`);
        continue;
      }
      const channel = computeChannel(entry);
      if (!channel) {
        log(`  ${label}: price ${entry.lastPriceSol} | building history (${entry.candles.length + (entry.currentCandle ? 1 : 0)}/${config.MIN_CANDLES_FOR_CHANNEL} candles)`);
      } else {
        const pos = openPositions.get(mint);
        const status = pos ? "HOLDING" : "watching";
        log(`  ${label}: ${status} | price ${entry.lastPriceSol} | channel [${channel.bottom.toFixed(8)} - ${channel.top.toFixed(8)}] | slope ${channel.slope > 0 ? "up" : channel.slope < 0 ? "down" : "flat"}`);
      }
    }
  }, 60 * 1000);
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
    const currentPriceSol = entry ? entry.lastPriceSol : null;
    const currentMultiple = currentPriceSol != null && pos.entryPriceSol ? currentPriceSol / pos.entryPriceSol : null;
    positions.push({
      mint,
      name: pos.name,
      symbol: pos.symbol,
      currentMultiple: currentMultiple != null ? Number(currentMultiple.toFixed(3)) : null,
      entryChannelBottom: pos.entryChannelBottom,
      entryChannelTop: pos.entryChannelTop,
      link: `https://pump.fun/${mint}`,
    });
  }

  const tracked = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [mint, entry] of tokenActivity.entries()) {
    if (openPositions.has(mint)) continue;
    const channel = computeChannel(entry);
    const candleCount = entry.candles.length + (entry.currentCandle ? 1 : 0);
    let pctFromBottom = null;
    let slope = null;
    if (channel && entry.lastPriceSol != null) {
      pctFromBottom = Number((((entry.lastPriceSol - channel.bottom) / (channel.top - channel.bottom)) * 100).toFixed(1));
      slope = channel.slope > 0 ? "up" : channel.slope < 0 ? "down" : "flat";
    }
    tracked.push({
      mint,
      name: entry.name,
      symbol: entry.symbol,
      hasPrice: entry.lastPriceSol != null,
      secondsSinceUpdate: entry.lastUpdatedSec != null ? nowSec - entry.lastUpdatedSec : null,
      channelReady: !!channel,
      candleCount,
      candlesNeeded: config.MIN_CANDLES_FOR_CHANNEL,
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
      DEXSCREENER_POLL_INTERVAL_SECONDS: config.DEXSCREENER_POLL_INTERVAL_SECONDS,
    },
    stats,
    positions,
    tracked,
    events: dashboardEvents,
  });
});

app.post("/api/add-token", (req, res) => {
  const mint = ((req.body && req.body.mint) || "").trim();
  res.json(addToken(mint));
});

app.post("/api/remove-token", (req, res) => {
  const mint = ((req.body && req.body.mint) || "").trim();
  res.json(removeToken(mint));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Dashboard server listening on port ${PORT}`);
});

log("=== pump.fun DEMO bot starting (MANUAL TOKENS ONLY, price via DexScreener) ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
log(`Starting demo balance: ${config.STARTING_BALANCE_SOL} SOL`);
log("No API key required. No automatic scanning. Add tokens via the dashboard to start trading them.");
startPolling();
