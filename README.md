# MartingaleBot — BTC 5m Signal Follower

BTC-led 5-minute Polymarket paper bot driven by the same 7-indicator Binance signal composite as the recovery bot (EMA, RSI, momentum, acceleration, volume surge, tick trend, window delta).

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators; lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait `ENTRY_ELAPSED` (10s) after the window opens, then buy the signal side (UP/DOWN) whenever **confidence is ≥ 70%**.
- **Flat 1000 shares** per buy. No martingale and no recovery mode.
- Single trade per window, hold to resolution.

## Stop Loss
- Applies to **any** open position: once the window has elapsed ≥ `STOP_LOSS_AFTER` (240s), if the held side's price drops **below** `STOP_LOSS_PRICE` (0.20), the stop is armed.
- The bot then **waits for the price to come back up to 0.20** before selling at 0.20 (never dumping below the stop level).

## Resolution
- Winner determined by the CLOB book in the last 2 seconds of the window (price ≥ 0.90 side wins). No fallback.

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).
