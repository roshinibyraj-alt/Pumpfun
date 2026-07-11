// ============================================================
// SETTINGS — edit these numbers to change how the bot behaves.
// You do NOT need to understand JavaScript to edit this file.
// Just change the numbers after the colons.
// ============================================================

module.exports = {
  // DEMO_MODE: true  = bot only PRETENDS to buy and logs it. No money moves. ALWAYS keep this true for now.
  // DEMO_MODE: false = bot would place real buys (NOT implemented in this version on purpose).
  DEMO_MODE: true,

  // Starting paper-trading balance in SOL. Purely a number in memory — not connected
  // to any real wallet. Every simulated buy subtracts FAKE_BUY_SIZE_SOL from this.
  STARTING_BALANCE_SOL: 5,

  // How much fake SOL the bot "spends" per simulated buy (just for logging/tracking, not real).
  FAKE_BUY_SIZE_SOL: 0.1,

  // Time window (in seconds) the bot looks back over when scoring a token as "trending".
  WINDOW_SECONDS: 60,

  // Minimum number of trades within WINDOW_SECONDS for a token to qualify as trending.
  MIN_TRADES_IN_WINDOW: 15,

  // Minimum number of DIFFERENT wallets buying within WINDOW_SECONDS.
  MIN_UNIQUE_BUYERS_IN_WINDOW: 8,

  // Minimum total SOL volume traded within WINDOW_SECONDS.
  MIN_SOL_VOLUME_IN_WINDOW: 5,

  // Once a token triggers a simulated buy, don't trigger again for this many seconds
  // (stops the bot from spamming the same coin over and over).
  COOLDOWN_SECONDS: 300,

  // ---------------- EXIT STRATEGY ----------------
  // These control how the bot manages a position AFTER it "buys". Approach:
  // 1) Take profit on half the position once it doubles, to pull your original
  //    capital back out. 2) Let the remaining half ride with a trailing stop,
  //    so a real mooner keeps running but a reversal locks in the gain.
  // 3) If it never even doubles and instead craters, cut losses early.

  // Multiple of entry price at which the bot sells 50% of the position.
  // 2.0 = sell half once the position is up 100% (doubled). That 50% sale at
  // 2x returns exactly your original SOL spent — the rest is now "free roll".
  TP1_MULTIPLIER: 2.0,

  // After TP1 triggers, the bot tracks the highest multiple reached and sells
  // the remaining half if price falls back this % from that peak.
  // 0.3 = sell if it drops 30% from its post-TP1 high.
  TRAILING_STOP_PCT: 0.3,

  // If the position never reaches TP1_MULTIPLIER and instead falls to this
  // multiple of entry, exit the full position to cut losses.
  // 0.5 = cut losses if it drops 50% before ever doubling.
  STOP_LOSS_MULTIPLIER: 0.5,

  // PumpPortal public data WebSocket. Free tier, no API key needed for new-token + public trade stream.
  WEBSOCKET_URL: "wss://pumpportal.fun/api/data",

  // How many recent events (new tokens + simulated buys) to keep for the dashboard.
  MAX_DASHBOARD_EVENTS: 200,
};
