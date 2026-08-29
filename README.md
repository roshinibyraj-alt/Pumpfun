# ConfidenceBot — BTC 5m Signal Follower

BTC-led 5-minute Polymarket paper bot driven by a 7-indicator Binance signal composite.

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators on Binance 1m candles + tick data:
  Window Delta, Micro Momentum, Acceleration, EMA 9/21, RSI 14, Volume Surge, Tick Trend.
- Lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait 10 seconds after the window opens, then:
  - lean UP and confidence >= 70% → buy UP 1000 shares
  - lean DOWN and confidence >= 70% → buy DOWN 1000 shares
- **Confirmation gate**: the lean must hold at confidence >= 70% for
  `SIGNAL_CONFIRM_N` consecutive signal evaluations (default 15 ≈ 3s at the
  200ms cadence) before an entry fires. This rejects transient/blip signal
  readings that would otherwise flip the direction against the true trend.
- Single trade per window, no stop loss, hold to resolution (Binance open vs close).
- After a loss, the next window's shares are 1.5x per consecutive loss (1000 → 1500 → 2250 → ...), reset on win.

## Sizing
- Base shares: 1000 (`FLAT_SHARES`)
- Martingale: `1.5^lossStreak` (`MARTINGALE_FACTOR`)

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).
