# ConfidenceBot — BTC 5m Signal Follower

BTC-led 5-minute Polymarket paper bot driven by a 7-indicator Binance signal composite.

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators on Binance 1m candles + tick data:
  Window Delta, Micro Momentum, Acceleration, EMA 9/21, RSI 14, Volume Surge, Tick Trend.
- Lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait 10 seconds after the window opens, then buy the signal side **only when
  confidence is exactly 100%** (`HIGH_CONF = 1.0`).
- **Confirmation gate**: the 100% lean must hold for `SIGNAL_CONFIRM_N`
  consecutive signal evaluations (default 15 ≈ 3s at the 200ms cadence) before
  an entry fires, rejecting sub-second blips.
- **Flat $100 bet**: shares = `round(DOLLAR_AMOUNT / price)` — never martingales.
- **One rebuy per window**: after a position is open, if the held side's ask
  drops below `REBUY_PRICE` (0.40) intra-window, buy another $100 of the same
  side. Purely price-based; at most one rebuy per window.
- No stop loss; hold to resolution (CLOB final-2s winner).

## Sizing
- Base bet: $100 (`DOLLAR_AMOUNT`) per leg, flat regardless of wins/losses.
- Rebuy trigger: held side ask < 0.40 (`REBUY_PRICE`).

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).
