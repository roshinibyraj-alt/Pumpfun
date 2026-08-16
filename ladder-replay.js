// ============================================================
// ladder-replay.js — PURE replay of the DUAL_LADDER strategy against
// a historical tick timeline. No network, no state. Used by learn.js
// to backtest the live strategy plus improvement variants:
//
//   base       — exactly what the live bot does today: 50 shares per
//                rung, cross-cancel same-price rungs, no cutoff.
//   timeFilter — deep rungs (0.15 / 0.10) may only fill before
//                TIME_FILTER_FRACTION of the window has elapsed
//                (a dip at 0.10 with seconds left is dead).
//   cap        — after CAP_RUNGS fills on one side, the lower rungs
//                fill at CAP_TAIL_SHARES (shrunk tail) instead of
//                the full rung size.
//   tp         — take profit: sell ALL held shares of a side at
//                TAKE_PROFIT when its mid bounces up to it
//                (buy the dip, sell the bounce).
//   all        — timeFilter + cap + tp combined.
//   leader     — DIRECTION EXPERIMENT: when one side crosses a rung
//                level (dips to it), buy 50 shares of the OPPOSITE
//                (leader) side via a resting limit at the MIRROR of
//                the dipped level (0.40 -> 0.60, ... 0.10 -> 0.90).
//                Tests the hypothesis that the dipping side is
//                overpriced and the leader side carries positive edge.
// ============================================================

const DEFAULTS = {
  rungs: [0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10],
  shares: 50,
  baseTakerFeeRate: 0.07,
  makerRebateRate: 0.20,
};

// Merges per-token tick arrays into a single chronologically ordered
// list of observations, carrying the last known price of each side
// forward so every observation has both up and down prices.
function mergeTicks(upTicks, downTicks) {
  const events = [];
  for (const x of upTicks || []) events.push({ t: x.t, up: x.p });
  for (const x of downTicks || []) events.push({ t: x.t, down: x.p });
  events.sort((a, b) => a.t - b.t);
  const out = [];
  let up = null, down = null;
  for (const e of events) {
    if (e.up != null) up = e.up;
    if (e.down != null) down = e.down;
    out.push({ t: e.t, up, down });
  }
  return out;
}

// Replays one window. opts:
//   windowStart, windowEnd (epoch seconds), upTicks, downTicks,
//   rungs, shares, timeFilterFraction, deepRungs, capRungs,
//   capTailShares, takeProfit, baseTakerFeeRate, makerRebateRate
// Returns { fills, sellEvents, cost, payout, rebates, pnl, winner,
//           fullRound, fullRoundWon, mixed, orders }.
function replayWindow(opts) {
  const windowStart = opts.windowStart;
  const windowEnd = opts.windowEnd;
  const rungs = (opts.rungs || DEFAULTS.rungs).slice().sort((a, b) => b - a);
  const shares = opts.shares != null ? opts.shares : DEFAULTS.shares;
  const takerFee = opts.baseTakerFeeRate != null ? opts.baseTakerFeeRate : DEFAULTS.baseTakerFeeRate;
  const rebateRate = opts.makerRebateRate != null ? opts.makerRebateRate : DEFAULTS.makerRebateRate;
  const timeFilterFraction = opts.timeFilterFraction;
  const deepRungs = opts.deepRungs || [];
  const capRungs = opts.capRungs;
  const capTailShares = opts.capTailShares != null ? opts.capTailShares : shares;
  const takeProfit = opts.takeProfit;
  const entrySkipSec = opts.entrySkipSec;
  const entryCutoffSec = opts.entryCutoffSec;
  const stopLossPrice = opts.stopLossPrice;
  const singleEntry = opts.singleEntry;
  const walkThrough = opts.walkThrough;
  const taker = !!opts.taker;
  const slipMin = opts.slippageMin != null ? opts.slippageMin : 0;
  const slipMax = opts.slippageMax != null ? opts.slippageMax : 0;
  // Seeded PRNG so taker-slippage backtests are reproducible.
  let rngSeed = (opts.seed != null ? opts.seed : 1) >>> 0;
  function slipDraw() {
    rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
    return rngSeed / 4294967296;
  }

  const windowSec = windowEnd - windowStart;
  const ticks = mergeTicks(opts.upTicks, opts.downTicks)
    .filter((t) => t.t >= windowStart && t.t <= windowEnd);

  const orders = [];
  const byKey = {};
  for (const side of ['UP', 'DOWN']) {
    for (const price of rungs) {
      const order = { side, price, shares, status: 'open', filledAt: null, cancelledAt: null };
      orders.push(order);
      byKey[side + ':' + price] = order;
    }
  }

  const fills = []; // { side, price, shares, fillAt, sold }
  const sellEvents = [];
  const sideFills = { UP: 0, DOWN: 0 };
  const leaderMode = !!opts.buyLeader;
  const triggered = {}; // leaderMode: side+level already triggered
  const last = { up: null, down: null };
  const pendingOrders = []; // walkThrough: resting leader limits awaiting walk-through
  let ordersPlaced = 0; // leader triggers placed this window (pending + filled)

  for (const t of ticks) {
    if (t.up != null) last.up = t.up;
    if (t.down != null) last.down = t.down;

    // LEADER MODE: when a side crosses a rung level, buy the opposite
    // (leader) side via a resting limit at the MIRROR of the dipped
    // level — once per level per side.
    if (leaderMode) {
      if (entrySkipSec != null && t.t - windowStart < entrySkipSec) continue;

      // STOP LOSS: if a held leader side's mid walks down to
      // stopLossPrice, exit those shares at stopLossPrice immediately
      // (realized — no re-entry).
      if (stopLossPrice != null) {
        for (const f of fills) {
          if (f.sold) continue;
          const cur = f.side === 'UP' ? last.up : last.down;
          if (cur != null && cur <= stopLossPrice) {
            f.sold = true;
            f.sellPrice = stopLossPrice;
            sellEvents.push({ side: f.side, shares: f.shares, price: stopLossPrice, at: t.t });
          }
        }
      }

      // WALK-THROUGH CONFIRMATION: a resting leader limit only fills
      // once that side's mid has walked through (<=) the limit price.
      // Orders that never walk through expire unfilled at window close.
      if (walkThrough && pendingOrders.length) {
        for (let i = pendingOrders.length - 1; i >= 0; i--) {
          const o = pendingOrders[i];
          const cur = o.side === 'UP' ? last.up : last.down;
          if (cur != null && cur <= o.price) {
            fills.push({ side: o.side, price: o.price, shares: o.shares, fillAt: t.t, sold: false, triggerLevel: o.triggerLevel, triggerSide: o.triggerSide });
            pendingOrders.splice(i, 1);
          }
        }
      }

      // No NEW entries in the last entryCutoffSec of the window —
      // existing fills still stop out (above) and ride to resolution.
      if (entryCutoffSec != null && t.t >= windowEnd - entryCutoffSec) continue;

      // singleEntry: one exposure per window — after the first trigger
      // no further triggers (no flip).
      if (singleEntry && ordersPlaced > 0) continue;

      for (const side of ['UP', 'DOWN']) {
        const px = side === 'UP' ? last.up : last.down;
        if (px == null) continue;
        const oppPx = side === 'UP' ? last.down : last.up;
        for (const price of rungs) {
          if (px > price) continue;
          const key = side + ':' + price;
          if (triggered[key] || oppPx == null) continue;
          triggered[key] = true;
          ordersPlaced++;
          if (taker) {
            // TAKER (v31): immediate fill at the current leader mid ±
            // realistic slippage (worse or better than the observed mid),
            // seeded for reproducibility.
            const slip = slipMin + slipDraw() * (slipMax - slipMin);
            const fillPx = Math.min(0.999, Math.max(0.001, Math.round((oppPx + slip) * 1000) / 1000));
            fills.push({ side: side === 'UP' ? 'DOWN' : 'UP', price: fillPx, shares, fillAt: t.t, sold: false, triggerLevel: price, triggerSide: side });
          } else {
            const mirror = Math.round((1 - price) * 100) / 100;
            const entry = { side: side === 'UP' ? 'DOWN' : 'UP', price: mirror, shares, fillAt: t.t, sold: false, triggerLevel: price, triggerSide: side };
            if (walkThrough) {
              pendingOrders.push({ ...entry, filled: false });
            } else {
              fills.push(entry);
            }
          }
          if (singleEntry) break; // one exposure per window
        }
        if (singleEntry && ordersPlaced > 0) break; // out of sides too
      }
      continue; // no ladder fills / TP in leader mode
    }

    // Fill pass — UP first, then DOWN; within a side highest rung
    // first (same deterministic order as bot.js).
    for (const side of ['UP', 'DOWN']) {
      const px = side === 'UP' ? last.up : last.down;
      if (px == null) continue;
      const openPrices = orders
        .filter((o) => o.side === side && o.status === 'open')
        .map((o) => o.price)
        .sort((a, b) => b - a);
      for (const price of openPrices) {
        if (px > price) break;
        const order = byKey[side + ':' + price];
        if (!order || order.status !== 'open') continue;

        // timeFilter: deep rungs must be touched early enough to
        // realistically recover.
        if (deepRungs.includes(price)) {
          const frac = windowSec > 0 ? (t.t - windowStart) / windowSec : 1;
          if (frac > timeFilterFraction) continue;
        }

        // cap: shrink the tail rungs once one side has already taken
        // several fills.
        let sh = order.shares;
        if (capRungs != null && sideFills[side] >= capRungs) sh = capTailShares;

        order.status = 'filled';
        order.filledAt = t.t;
        order.fillShares = sh;
        fills.push({ side, price, shares: sh, fillAt: t.t, sold: false });
        sideFills[side] += 1;

        const opp = byKey[(side === 'UP' ? 'DOWN' : 'UP') + ':' + price];
        if (opp && opp.status === 'open') {
          opp.status = 'cancelled';
          opp.cancelledAt = t.t;
        }
      }
    }

    // Take profit: if a side's mid has bounced up to TAKE_PROFIT, sell
    // every share of that side at the TP price.
    if (takeProfit != null) {
      for (const side of ['UP', 'DOWN']) {
        const px = side === 'UP' ? last.up : last.down;
        if (px == null || px < takeProfit) continue;
        const held = fills.filter((f) => f.side === side && !f.sold);
        if (held.length === 0) continue;
        const sh = held.reduce((a, f) => a + f.shares, 0);
        for (const f of held) { f.sold = true; f.sellPrice = takeProfit; }
        sellEvents.push({ side, shares: sh, price: takeProfit, at: t.t });
      }
    }
  }

  // Resolution: prefer the authoritative outcome (from Gamma's
  // outcomePrices on the closed market) when provided; otherwise
  // mirror the bot — a side observed at/above 0.90 wins, else the
  // higher last price wins.
  let winner = opts.winnerOverride || null;
  if (winner == null && last.up != null && last.up >= 0.90) winner = 'UP';
  else if (last.down != null && last.down >= 0.90) winner = 'DOWN';
  else if (last.up != null && last.down != null) winner = last.up > last.down ? 'UP' : 'DOWN';
  else if (last.up != null) winner = 'UP';
  else if (last.down != null) winner = 'DOWN';

  let cost = 0, payout = 0, rebates = 0, fees = 0;
  for (const f of fills) {
    const feeEquiv = f.shares * takerFee * f.price * (1 - f.price);
    if (taker) fees += feeEquiv; else rebates += feeEquiv * rebateRate;
    cost += f.shares * f.price;
    if (f.sold) {
      const sp = f.sellPrice != null ? f.sellPrice : takeProfit;
      payout += f.shares * sp;
      // A stop-loss exit is a taker sell too — it pays the taker fee.
      if (taker) fees += f.shares * takerFee * sp * (1 - sp);
    }
    else if (winner === f.side) payout += f.shares;
  }
  const pnl = payout - cost - fees + rebates;
  const fullRound = fills.length === rungs.length;
  const sides = new Set(fills.map((f) => f.side));

  return {
    fills,
    sellEvents,
    cost,
    payout,
    rebates,
    fees,
    pnl,
    winner,
    fullRound,
    fullRoundWon: fullRound && pnl >= 0,
    mixed: fills.length > 0 && sides.size === 2,
    orders,
    placedOrders: ordersPlaced,
    expired: pendingOrders.length,
  };
}

module.exports = { replayWindow, mergeTicks };
