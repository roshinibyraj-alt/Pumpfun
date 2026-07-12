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
  // Set this to true temporarily to confirm the pipeline fires at all, using
  // much looser activity thresholds for the initial "is this token alive"
  // check. It does NOT loosen the channel logic itself.
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

  // ---------------- CHANNEL (TREND LINE) STRATEGY ----------------
  // Instead of a fixed take-profit or trailing stop, the bot builds a real
  // 1-minute trend line (a linear regression channel) per token from its
  // recent price history. It buys when price touches the BOTTOM of that
  // channel and sells the full position when price touches the TOP.
  // After a sell, the bot keeps watching that same token for the next
  // bottom-line touch — it doesn't blacklist it.

  // How many 1-minute candles of history are required before the bot trusts
  // the channel enough to trade it. 10 = needs 10 minutes of price history.
  MIN_CANDLES_FOR_CHANNEL: 10,

  // How many 1-minute candles to keep in memory per token (older ones are
  // dropped). 60 = up to 1 hour of history feeds the channel calculation.
  MAX_CANDLES_STORED: 60,

  // How wide the channel is, measured in standard deviations of price around
  // the trend line. Higher = wider channel = fewer but more extreme touches.
  CHANNEL_WIDTH_STDDEV: 1.5,

  // If true, the bot will NOT buy a "bottom line touch" when the channel's
  // overall trend is pointed downward — this avoids buying every dip in a
  // coin that's simply crashing (a falling knife), and instead only buys
  // dips within a flat-to-upward channel.
  REQUIRE_NON_NEGATIVE_SLOPE: true,

  // ---------------- ACTIVITY FILTER (still required before channel trading) ----------------
  // A token still has to prove it's actually alive/trending before the bot
  // will even start trading its channel — this prevents building a "trend
  // line" on a token nobody is trading.

  // Time window (in seconds) the bot looks back over when scoring a token as "trending".
  WINDOW_SECONDS: 60,

  // Minimum number of trades within WINDOW_SECONDS for a token to qualify as trending.
  MIN_TRADES_IN_WINDOW: 15,

  // Minimum number of DIFFERENT wallets buying within WINDOW_SECONDS.
  MIN_UNIQUE_BUYERS_IN_WINDOW: 8,

  // Minimum total SOL volume traded within WINDOW_SECONDS.
  MIN_SOL_VOLUME_IN_WINDOW: 5,

  // Loosened versions used only while TEST_MODE is true, just to prove the
  // pipeline (data -> activity check -> channel -> buy) works end to end.
  TEST_MIN_TRADES_IN_WINDOW: 4,
  TEST_MIN_UNIQUE_BUYERS_IN_WINDOW: 2,
  TEST_MIN_SOL_VOLUME_IN_WINDOW: 0.5,

  // Once a token triggers a simulated buy, don't trigger another buy for at
  // least this many seconds — but it CAN trigger again on the same token
  // after that (channel trading is designed to repeat on the same coin).
  COOLDOWN_SECONDS: 120,

  // ---------------- SAFETY BACKSTOP (not a trading signal) ----------------
  // This is deliberately NOT part of the buy/sell strategy above — it's a
  // last-resort circuit breaker in case a token is in true freefall (where
  // the channel's bottom line would otherwise just keep sliding down with
  // it, causing repeated buys into a coin heading toward zero). If a
  // position falls to this multiple of its entry price, exit immediately
  // regardless of where the channel is. 0.5 = cut losses at -50%.
  // Set to null to disable this safety net entirely.
  SAFETY_STOP_LOSS_MULTIPLIER: 0.5,

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
