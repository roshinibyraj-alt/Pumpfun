// ============================================================
// SETTINGS — edit these numbers to change how the bot behaves.
// You do NOT need to understand JavaScript to edit this file.
// Just change the numbers after the colons.
// ============================================================

module.exports = {
  // DEMO_MODE: true  = bot only PRETENDS to buy and logs it. No money moves. ALWAYS keep this true for now.
  // DEMO_MODE: false = bot would place real buys (NOT implemented in this version on purpose).
  DEMO_MODE: true,

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

  // PumpPortal public data WebSocket. Free tier, no API key needed for new-token + public trade stream.
  WEBSOCKET_URL: "wss://pumpportal.fun/api/data",

  // How many recent events (new tokens + simulated buys) to keep for the dashboard.
  MAX_DASHBOARD_EVENTS: 200,
};
