// ============================================================
// SETTINGS — edit these numbers to change how the bot behaves.
// You do NOT need to understand JavaScript to edit this file.
// Just change the numbers after the colons.
// ============================================================

module.exports = {
  // DEMO_MODE: true  = bot only PRETENDS to buy and logs it. No money moves. ALWAYS keep this true for now.
  DEMO_MODE: true,

  // Starting paper-trading balance in SOL. Purely a number in memory.
  STARTING_BALANCE_SOL: 5,

  // ---------------- MARTINGALE STRATEGY ----------------
  // 1. Buy immediately when you add a token (BASE_BUY_SIZE_SOL).
  // 2. Every time price falls DROP_TRIGGER_PCT below the CURRENT average
  //    entry price (which moves as you add), buy again at
  //    MARTINGALE_MULTIPLIER times the previous buy size. This pulls the
  //    average entry price down each time.
  // 3. Take profit: sell the ENTIRE position when price is TP_PCT above
  //    the current average entry price.
  // 4. After taking profit, start a fresh cycle on the same token
  //    (see RESTART_AFTER_TP).

  // Size of the very first buy on a token, in SOL.
  BASE_BUY_SIZE_SOL: 0.1,

  // How far (%) price must fall below the current average entry price to
  // trigger the next double-down buy. 0.5 = 50% down.
  DROP_TRIGGER_PCT: 0.5,

  // Multiplier applied to the previous buy size each time it doubles down.
  // 2 = classic Martingale (0.1 -> 0.2 -> 0.4 -> 0.8 -> 1.6 SOL ...).
  MARTINGALE_MULTIPLIER: 2,

  // How far (%) price must rise above the current average entry price to
  // trigger a full take-profit exit. 1.0 = 100% up (average entry doubles).
  TP_PCT: 1.0,

  // Safety cap: maximum number of times the bot will double down on a
  // single token before it just holds and waits (won't add further levels,
  // but will still exit on TP if price recovers). This is NOT part of your
  // requested strategy — it's a risk cap I added since uncapped doubling
  // can exceed your balance fast. Set to a very high number to effectively
  // disable it if you want pure, uncapped Martingale.
  // Example cost if all levels hit at BASE=0.1, MULTIPLIER=2:
  // level 1: 0.1, 2: 0.2, 3: 0.4, 4: 0.8, 5: 1.6 SOL (3.1 SOL total invested)
  MAX_MARTINGALE_LEVELS: 5,

  // After a take-profit exit, immediately start a new cycle (fresh initial
  // buy) on the same token. Set to false to just stop and hold cash after
  // a TP, requiring you to manually re-add the token to trade it again.
  RESTART_AFTER_TP: true,

  // ---------------- PRICE DATA SOURCE: DexScreener ----------------
  // Free public REST API, no key required, no wallet, no metering cost.
  DEXSCREENER_POLL_INTERVAL_SECONDS: 30,

  // Known non-memecoin mints to always refuse to add.
  EXCLUDED_MINTS: [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "So11111111111111111111111111111111111111112", // Wrapped SOL
  ],

  // Safety valve: max number of tokens you can manually track at once.
  MAX_TRACKED_TOKENS: 30,

  // How many recent events to keep for the dashboard.
  MAX_DASHBOARD_EVENTS: 200,
};
