// ============================================================
// pump.fun DEMO bot — MANUAL TOKENS ONLY, Martingale strategy
// - No automatic scanning. You add tokens by mint address via the dashboard.
// - Price data comes from DexScreener's free public REST API — no key,
//   no wallet, no metering cost. Polled on an interval.
// - STRATEGY (Martingale):
//   1. Buy immediately when a token is added (BASE_BUY_SIZE_SOL).
//   2. Every time price falls DROP_TRIGGER_PCT below the CURRENT average
//      entry price, buy again at MARTINGALE_MULTIPLIER x the previous
//      buy size. This pulls the average entry price down.
//   3. Take profit: sell the ENTIRE position when price is TP_PCT above
//      the current average entry price.
//   4. After taking profit, start a fresh cycle on the same token
//      (if RESTART_AFTER_TP is true).
// - DEMO_MODE = true means: no real money, no real wallet, ever.
// ============================================================

const express = require("express");
const path = require("path");
const config = require("./config.js");

// One entry per MANUALLY ADDED token mint address.
// { name, symbol, lastPriceSol, lastUpdatedSec, addedAtSec }
const tokenActivity = new Map();

// One entry per token mint address with an OPEN Martingale position.
// { levels: [{priceSol, solIn}], totalSolIn, sumTokensProxy, averageEntryPrice, currentLevel, lastActionSec }
const openPositions = new Map();

// Tokens waiting for their very first buy (set right after being added).
const pendingInitialBuy = new Set();

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
// Martingale position math
// ------------------------------------------------------------
// averageEntryPrice = totalSolIn / sumTokensProxy, where each buy
// contributes tokensProxy = solIn / priceAtBuy. This is the correct
// SOL-weighted average price across buys of different sizes at
// different prices (equivalent to a real average cost basis).

function nextBuySizeSol(position) {
  if (!position) return config.BASE_BUY_SIZE_SOL;
  return config.BASE_BUY_SIZE_SOL * Math.pow(config.MARTINGALE_MULTIPLIER, position.currentLevel);
}

function currentPositionValueSol(position, currentPriceSol) {
  return position.sumTokensProxy * currentPriceSol;
}

// ------------------------------------------------------------
// Execute a buy (either the initial one or a double-down)
// ------------------------------------------------------------
function executeBuy(mint, entry, nowSec, isInitial) {
  const label = entry.symbol || entry.name || mint;
  let position = openPositions.get(mint);
  const buySizeSol = isInitial ? config.BASE_BUY_SIZE_SOL : nextBuySizeSol(position);

  if (!config.DEMO_MODE) {
    log("DEMO_MODE is false but real-buy logic is not implemented. Doing nothing.");
    return;
  }

  if (stats.balanceSol < buySizeSol) {
    log(`SKIPPED (out of demo balance): ${label} needed ${buySizeSol} SOL, balance is ${stats.balanceSol.toFixed(3)} SOL`);
    pushEvent({ type: "skipped_low_balance", mint, name: entry.name, symbol: entry.symbol, balanceSol: Number(stats.balanceSol.toFixed(3)), neededSol: buySizeSol });
    return;
  }

  const priceSol = entry.lastPriceSol;
  const tokensProxy = buySizeSol / priceSol;

  stats.simulatedBuys += 1;
  stats.balanceSol = Number((stats.balanceSol - buySizeSol).toFixed(6));
  stats.totalSpentSol = Number((stats.totalSpentSol + buySizeSol).toFixed(6));

  if (!position) {
    position = {
      levels: [],
      totalSolIn: 0,
      sumTokensProxy: 0,
      averageEntryPrice: null,
      currentLevel: 0,
      lastActionSec: 0,
    };
    openPositions.set(mint, position);
  }

  position.levels.push({ priceSol, solIn: buySizeSol });
  position.totalSolIn = Number((position.totalSolIn + buySizeSol).toFixed(6));
  position.sumTokensProxy += tokensProxy;
  position.averageEntryPrice = position.totalSolIn / position.sumTokensProxy;
  position.currentLevel += 1;
  position.lastActionSec = nowSec;

  const levelLabel = isInitial ? "INITIAL BUY" : `DOUBLE DOWN (level ${position.currentLevel})`;
  log(
    `${levelLabel}: ${label} (${mint}) - bought ${buySizeSol} SOL at ${priceSol} - new average entry ${position.averageEntryPrice} - balance ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: isInitial ? "initial_buy" : "double_down",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    buySizeSol,
    priceSol,
    averageEntryPrice: position.averageEntryPrice,
    level: position.currentLevel,
    balanceAfterSol: stats.balanceSol,
    link: `https://pump.fun/${mint}`,
  });
}

// ------------------------------------------------------------
// Take profit: sell the entire position
// ------------------------------------------------------------
function takeProfit(mint, entry, position, currentPriceSol) {
  const solOut = currentPositionValueSol(position, currentPriceSol);
  const pnl = solOut - position.totalSolIn;

  stats.balanceSol = Number((stats.balanceSol + solOut).toFixed(6));
  stats.realizedPnlSol = Number((stats.realizedPnlSol + pnl).toFixed(6));

  const label = entry.symbol || entry.name || mint;
  log(
    `TAKE PROFIT: ${label} sold entire position (${position.currentLevel} level(s), ${position.totalSolIn} SOL in) at ${currentPriceSol} - realized ${solOut.toFixed(
      4
    )} SOL (pnl +${pnl.toFixed(4)} SOL) - balance ${stats.balanceSol} SOL`
  );

  pushEvent({
    type: "take_profit",
    mint,
    name: entry.name,
    symbol: entry.symbol,
    levels: position.currentLevel,
    totalSolIn: position.totalSolIn,
    solOut: Number(solOut.toFixed(4)),
    pnlSol: Number(pnl.toFixed(4)),
    balanceAfterSol: stats.balanceSol,
    link: `https://pump.fun/${mint}`,
  });

  openPositions.delete(mint);

  if (config.RESTART_AFTER_TP) {
    pendingInitialBuy.add(mint);
    log(`${label}: restarting a fresh Martingale cycle on the same token.`);
  }
}

// ------------------------------------------------------------
// Called on every price update for a tracked token
// ------------------------------------------------------------
function evaluateToken(mint, entry, nowSec) {
  if (entry.lastPriceSol == null) return;

  if (pendingInitialBuy.has(mint) && !openPositions.has(mint)) {
    pendingInitialBuy.delete(mint);
    executeBuy(mint, entry, nowSec, true);
    return;
  }

  const position = openPositions.get(mint);
  if (!position) return;

  const currentPrice = entry.lastPriceSol;
  const avg = position.averageEntryPrice;

  // Take profit check first.
  if (currentPrice >= avg * (1 + config.TP_PCT)) {
    takeProfit(mint, entry, position, currentPrice);
    return;
  }

  // Double-down check.
  if (position.currentLevel >= config.MAX_MARTINGALE_LEVELS) return; // capped, just hold and wait for TP
  const dropTriggerPrice = avg * (1 - config.DROP_TRIGGER_PCT);
  if (currentPrice <= dropTriggerPrice) {
    executeBuy(mint, entry, nowSec, false);
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
  });
  pendingInitialBuy.add(mint);

  log(`MANUALLY ADDED: ${mint} - will buy immediately once a price is available from DexScreener`);
  pushEvent({ type: "token_added", mint, link: `https://pump.fun/${mint}` });

  pollTokens([mint]).catch((err) => log("Immediate poll for new token failed:", err.message));

  return { ok: true };
}

function removeToken(mint) {
  if (!tokenActivity.has(mint)) return { ok: false, error: "Not currently tracking that token." };

  const entry = tokenActivity.get(mint);
  const position = openPositions.get(mint);
  if (position && entry.lastPriceSol != null) {
    const solOut = currentPositionValueSol(position, entry.lastPriceSol);
    const pnl = solOut - position.totalSolIn;
    stats.balanceSol = Number((stats.balanceSol + solOut).toFixed(6));
    stats.realizedPnlSol = Number((stats.realizedPnlSol + pnl).toFixed(6));
    log(`REMOVED (position closed): ${mint} sold at ${entry.lastPriceSol} - realized ${solOut.toFixed(4)} SOL (pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL)`);
    pushEvent({
      type: "manual_removal_exit",
      mint,
      name: entry.name,
      symbol: entry.symbol,
      solOut: Number(solOut.toFixed(4)),
      pnlSol: Number(pnl.toFixed(4)),
      balanceAfterSol: stats.balanceSol,
    });
  }

  openPositions.delete(mint);
  pendingInitialBuy.delete(mint);
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
      if (!pair) continue;

      if (pair.baseToken.name && !entry.name) entry.name = pair.baseToken.name;
      if (pair.baseToken.symbol && !entry.symbol) entry.symbol = pair.baseToken.symbol;

      const price = parseFloat(pair.priceNative);
      if (!Number.isFinite(price)) continue;

      entry.lastPriceSol = price;
      entry.lastUpdatedSec = nowSec;

      evaluateToken(mint, entry, nowSec);
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

  setInterval(() => {
    log(`HEARTBEAT: ${tokenActivity.size} tracked token(s) | ${openPositions.size} open position(s) | last poll: ${stats.lastPollStatus}`);
    for (const [mint, entry] of tokenActivity.entries()) {
      const label = entry.symbol || entry.name || mint;
      if (entry.lastPriceSol == null) {
        log(`  ${label}: no price data yet`);
        continue;
      }
      const position = openPositions.get(mint);
      if (!position) {
        log(`  ${label}: no open position (waiting for initial buy) | price ${entry.lastPriceSol}`);
      } else {
        const dropTrigger = position.averageEntryPrice * (1 - config.DROP_TRIGGER_PCT);
        const tpTrigger = position.averageEntryPrice * (1 + config.TP_PCT);
        log(
          `  ${label}: level ${position.currentLevel}/${config.MAX_MARTINGALE_LEVELS} | price ${entry.lastPriceSol} | avg entry ${position.averageEntryPrice.toFixed(
            10
          )} | next dip buy at ${dropTrigger.toFixed(10)} | TP at ${tpTrigger.toFixed(10)} | invested ${position.totalSolIn} SOL`
        );
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
  for (const [mint, position] of openPositions.entries()) {
    const entry = tokenActivity.get(mint);
    const currentPriceSol = entry ? entry.lastPriceSol : null;
    const currentValueSol = currentPriceSol != null ? currentPositionValueSol(position, currentPriceSol) : null;
    const unrealizedPnl = currentValueSol != null ? currentValueSol - position.totalSolIn : null;
    positions.push({
      mint,
      name: position.levels.length ? entry.name : null,
      symbol: entry ? entry.symbol : null,
      currentPriceSol,
      averageEntryPrice: position.averageEntryPrice,
      totalSolIn: position.totalSolIn,
      currentLevel: position.currentLevel,
      maxLevels: config.MAX_MARTINGALE_LEVELS,
      nextDropTrigger: position.averageEntryPrice * (1 - config.DROP_TRIGGER_PCT),
      tpTrigger: position.averageEntryPrice * (1 + config.TP_PCT),
      unrealizedPnlSol: unrealizedPnl != null ? Number(unrealizedPnl.toFixed(4)) : null,
      link: `https://pump.fun/${mint}`,
    });
  }

  const tracked = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [mint, entry] of tokenActivity.entries()) {
    if (openPositions.has(mint)) continue;
    tracked.push({
      mint,
      name: entry.name,
      symbol: entry.symbol,
      hasPrice: entry.lastPriceSol != null,
      secondsSinceUpdate: entry.lastUpdatedSec != null ? nowSec - entry.lastUpdatedSec : null,
      awaitingInitialBuy: pendingInitialBuy.has(mint),
      link: `https://pump.fun/${mint}`,
    });
  }

  res.json({
    config: {
      DEMO_MODE: config.DEMO_MODE,
      BASE_BUY_SIZE_SOL: config.BASE_BUY_SIZE_SOL,
      DROP_TRIGGER_PCT: config.DROP_TRIGGER_PCT,
      MARTINGALE_MULTIPLIER: config.MARTINGALE_MULTIPLIER,
      TP_PCT: config.TP_PCT,
      MAX_MARTINGALE_LEVELS: config.MAX_MARTINGALE_LEVELS,
      RESTART_AFTER_TP: config.RESTART_AFTER_TP,
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

log("=== pump.fun DEMO bot starting (MANUAL TOKENS ONLY, Martingale strategy) ===");
log(`DEMO_MODE = ${config.DEMO_MODE} (true = safe, no real money is ever used)`);
log(`Starting demo balance: ${config.STARTING_BALANCE_SOL} SOL`);
log(`Strategy: buy ${config.BASE_BUY_SIZE_SOL} SOL initially, double down ${config.MARTINGALE_MULTIPLIER}x every ${Math.round(config.DROP_TRIGGER_PCT*100)}% drop from average entry, TP at +${Math.round(config.TP_PCT*100)}% from average entry, max ${config.MAX_MARTINGALE_LEVELS} levels.`);
startPolling();
