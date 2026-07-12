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

  // ---------------- TEST MODE ----------------
  // Set this to true temporarily to confirm the buy logic actually fires at
  // all, using much looser thresholds. Once you've seen a few simulated buys
  // happen, set it back to false to use your real thresholds below.
  TEST_MODE: false,

  // ---------------- TOKEN AGE FILTER ----------------
  // This is the core "don't snipe" rule: only consider a token for a buy if
  // it has survived at least this long since launch. Brand-new pump.fun
  // tokens are mostly bot-driven noise or straight rugs in their first
  // minutes — waiting lets you see if real organic interest shows up instead.
  // 600 seconds = 10 minutes.
  MIN_TOKEN_AGE_SECONDS: 600,

  // Upper bound so the bot isn't chasing a token that's basically dead and
  // just had one late flicker of activity. 36000 seconds = 10 hours.
  MAX_TOKEN_AGE_SECONDS: 36000,

  // ---------------- BUY-THE-DIP STRATEGY ----------------
  // Instead of buying the instant a token crosses the trending thresholds
  // (which means buying into strength/a spike), the bot puts it on a
  // watchlist first and waits for a pullback from its peak before buying.
  // "Sell at the top" is already handled by TP1 + the trailing stop below.

  // How far (%) a token must pull back from its peak (since it was first
  // flagged trending) before the bot buys. 0.15 = wait for a 15% dip.
  DIP_BUY_PCT: 0.15,

  // If a trending token never pulls back within this many seconds, drop it
  // from the watchlist instead of waiting forever or chasing it higher.
  // 1800 = 30 minutes.
  WATCHLIST_MAX_WAIT_SECONDS: 1800,

  // Minimum trades still happening in the window at the moment of the dip,
  // just to confirm the token isn't simply dead (a "dip" to zero activity
  // isn't a real buy signal).
  MIN_WATCH_ACTIVITY_TRADES: 2,

  // Time window (in seconds) the bot looks back over when scoring a token as "trending".
  WINDOW_SECONDS: 60,

  // Minimum number of trades within WINDOW_SECONDS for a token to qualify as trending.
  MIN_TRADES_IN_WINDOW: 15,

  // Minimum number of DIFFERENT wallets buying within WINDOW_SECONDS.
  MIN_UNIQUE_BUYERS_IN_WINDOW: 8,

  // Minimum total SOL volume traded within WINDOW_SECONDS.
  MIN_SOL_VOLUME_IN_WINDOW: 5,

  // Loosened versions used only while TEST_MODE is true, just to prove the
  // pipeline (data -> scoring -> buy -> position management) works end to end.
  TEST_MIN_TRADES_IN_WINDOW: 4,
  TEST_MIN_UNIQUE_BUYERS_IN_WINDOW: 2,
  TEST_MIN_SOL_VOLUME_IN_WINDOW: 0.5,

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

  // PumpPortal API key, required specifically for subscribeTokenTrade (trade
  // data) to actually deliver events. Set this in Railway as an environment
  // variable named PUMPPORTAL_API_KEY — never hardcode it here.
  // subscribeNewToken (token creation events) works fine without a key;
  // subscribeTokenTrade (trade data) requires a key tied to a wallet funded
  // with at least 0.02 SOL, metered at 0.01 SOL per 10,000 events.
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || "",

  // Known non-memecoin mints to always ignore, even if a trade message
  // references them. Guards against edge cases where a migrated token's
  // trade payload (e.g. PumpSwap swaps against a stablecoin) gets misread
  // and the quote currency ends up looking like "the token" being traded.
  EXCLUDED_MINTS: [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "So11111111111111111111111111111111111111112", // Wrapped SOL
  ],

  // How many recent events (new tokens + simulated buys) to keep for the dashboard.
  MAX_DASHBOARD_EVENTS: 200,
};
