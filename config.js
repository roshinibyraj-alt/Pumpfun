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
  // There is no automatic scanning or discovery of new tokens. The bot only
  // trades tokens you explicitly add via the dashboard.

  // Once a token triggers a simulated buy, don't trigger another buy on the
  // SAME token again for at least this many seconds after a sell.
  COOLDOWN_SECONDS: 120,

  // ---------------- PRICE DATA SOURCE: DexScreener ----------------
  // Free public REST API, no key required, no wallet, no metering cost.
  // The bot polls current price for every tracked token on this interval
  // and builds its own 1-minute candles from those snapshots — same idea
  // as before, just pulled instead of pushed, and free instead of paid.

  // How often (seconds) to poll DexScreener for all tracked tokens' prices.
  // All tracked tokens are fetched in a single request each poll (up to 30
  // addresses per call), so this stays well within DexScreener's public
  // rate limit (300 requests/minute) even at a short interval.
  DEXSCREENER_POLL_INTERVAL_SECONDS: 30,

  // ---------------- CHANNEL (TREND LINE) STRATEGY ----------------
  // The bot builds a real 1-minute trend line (a linear regression channel)
  // per token from its recent price history, buys when price touches the
  // BOTTOM of that channel, and sells the full position when price touches
  // the TOP. After a sell, it keeps watching the same token for the next
  // bottom-line touch.

  // How many 1-minute candles of history are required before the bot trusts
  // the channel enough to trade it. 10 = needs about 10 minutes after you
  // add the token (roughly 20 polls at the default 30s interval).
  MIN_CANDLES_FOR_CHANNEL: 10,

  // How many 1-minute candles to keep in memory per token.
  MAX_CANDLES_STORED: 60,

  // How wide the channel is, measured in standard deviations of price around
  // the trend line. Higher = wider channel = fewer but more extreme touches.
  CHANNEL_WIDTH_STDDEV: 1.5,

  // If true, the bot will NOT buy a "bottom line touch" when the channel's
  // overall trend is pointed downward — avoids buying every dip in a coin
  // that's simply crashing, and only buys dips within a flat-to-upward channel.
  REQUIRE_NON_NEGATIVE_SLOPE: true,

  // ---------------- SAFETY BACKSTOP (not a trading signal) ----------------
  // A last-resort circuit breaker in case a token is in true freefall. If a
  // position falls to this multiple of its entry price, exit immediately
  // regardless of where the channel is. 0.5 = cut losses at -50%.
  // Set to null to disable this safety net entirely.
  SAFETY_STOP_LOSS_MULTIPLIER: 0.5,

  // Known non-memecoin mints to always refuse to add — real stablecoins/
  // wrapped SOL, not meme tokens.
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
