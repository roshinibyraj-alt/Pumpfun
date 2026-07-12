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

  // ---------------- MANUAL-ONLY MODE ----------------
  // There is no automatic scanning or discovery of new tokens anymore. The
  // bot only trades tokens you explicitly add via the dashboard. This also
  // means it only ever holds a live PumpPortal trade subscription (and only
  // pays PumpPortal's message-metering fee) for tokens you've chosen.

  // Once a token triggers a simulated buy, don't trigger another buy on the
  // SAME token again for at least this many seconds after a sell.
  COOLDOWN_SECONDS: 120,

  // ---------------- CHANNEL (TREND LINE) STRATEGY ----------------
  // The bot builds a real 1-minute trend line (a linear regression channel)
  // per token from its recent price history, buys when price touches the
  // BOTTOM of that channel, and sells the full position when price touches
  // the TOP. After a sell, it keeps watching the same token for the next
  // bottom-line touch.

  // How many 1-minute candles of history are required before the bot trusts
  // the channel enough to trade it. 10 = needs 10 minutes of price history
  // after you add the token.
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

  // ---------------- SAFETY BACKSTOP (not a trading signal) ----------------
  // This is deliberately NOT part of the buy/sell strategy above — it's a
  // last-resort circuit breaker in case a token is in true freefall (where
  // the channel's bottom line would otherwise just keep sliding down with
  // it, causing repeated buys into a coin heading toward zero). If a
  // position falls to this multiple of its entry price, exit immediately
  // regardless of where the channel is. 0.5 = cut losses at -50%.
  // Set to null to disable this safety net entirely.
  SAFETY_STOP_LOSS_MULTIPLIER: 0.5,

  // PumpPortal public data WebSocket.
  WEBSOCKET_URL: "wss://pumpportal.fun/api/data",

  // PumpPortal API key, required for subscribeTokenTrade (trade data) to
  // actually deliver events. Set this in Railway as an environment variable
  // named PUMPPORTAL_API_KEY — never hardcode it here. Requires a wallet
  // funded with a small amount of real SOL, metered per message volume —
  // now only spent on tokens you manually add, not on platform-wide scanning.
  PUMPPORTAL_API_KEY: process.env.PUMPPORTAL_API_KEY || "",

  // Known non-memecoin mints to always refuse to add, even manually — these
  // are real stablecoins/wrapped SOL, not meme tokens, and trading logic
  // built for meme-coin volatility doesn't make sense applied to them.
  EXCLUDED_MINTS: [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "So11111111111111111111111111111111111111112", // Wrapped SOL
  ],

  // Safety valve: max number of tokens you can manually track at once
  // (keeps PumpPortal message-metering costs predictable).
  MAX_TRACKED_TOKENS: 30,

  // How many recent events to keep for the dashboard.
  MAX_DASHBOARD_EVENTS: 200,
};
