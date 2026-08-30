# ConfidenceBot — BTC 5m Signal Follower

BTC-led 5-minute Polymarket paper bot driven by a 7-indicator Binance signal composite.

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators on Binance 1m candles + tick data:
  Window Delta, Micro Momentum, Acceleration, EMA 9/21, RSI 14, Volume Surge, Tick Trend.
- Lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait 10 seconds after the window opens, then buy the signal side (UP/DOWN)
  whenever **confidence is above `ENTRY_CONF` (0.65)** with a flat 1000 shares.
- **Confirmation gate**: the >0.65 lean must hold for `SIGNAL_CONFIRM_N`
  consecutive signal evaluations (default 15 ≈ 3s at the 200ms cadence) before
  an entry fires, rejecting sub-second blips.
- **Intra-window exit**: once the confidence score goes neutral (no UP/DOWN
  lean), the held position is sold immediately at the current mark/ask.
- **Re-entry**: if the signal comes back (>0.65) after a neutral sell, the bot
  buys again — multiple round trips are allowed within one window.
- No stop loss; anything still open at window end is held to resolution.

## Sizing
- Flat 1000 shares per buy (`FLAT_SHARES`), no martingale and no dollar sizing.

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).
