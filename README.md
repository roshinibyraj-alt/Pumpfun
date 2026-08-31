# FlatlineBot — BTC 5m Signal Follower (Pumpfun repo)

BTC-led 5-minute Polymarket paper bot driven by the 7-indicator Binance signal composite (EMA, RSI, momentum, acceleration, volume surge, tick trend, window delta).

## Strategy
- Watch the `btc-updown-5m-*` market only.
- Compute a composite score from 7 indicators; lean = UP (score > 0) or DOWN (score < 0). Confidence = |score| / 7.0.
- Wait `ENTRY_ELAPSED` (10s) after the window opens, then buy the signal side (UP/DOWN) whenever **confidence is ≥ 70%**.
- **Dynamic base sizing**: starts at **$500**, +$100 per loss, −$100 per win, floor $500, cap $1,500 (10 additions max). Shares = `floor(base / entry price)`.
- **One trade per window** — always exactly one position, no re-entries, no intra-window sells.
- **No stop loss** — every position is held to resolution. Winner pays 1.0, loser pays 0.

## Resolution
- Winner determined by the CLOB book in the last 2 seconds of the window (price ≥ 0.90 side wins). No fallback.

## Pricing
All market prices come from batched CLOB `/books` snapshots. Signal data comes from Binance public REST (candles + tick price).

## Config (env vars)
| Var | Default | Meaning |
| --- | --- | --- |
| `FLAT_BUDGET` | `500` | Starting base bet (dynamic: ±$100 per win/loss, floor $500, cap $1,500) |
| `HIGH_CONF` | `0.70` | Minimum confidence to take the signal side |
| `ENTRY_ELAPSED` | `10` | Wait after window open before entry |
| `START_BANKROLL` | `20000` | Demo starting capital |
| `TAKER_FEE_RATE` | `0.07` | Polymarket taker fee rate (%) |

## Run
```bash
npm install
npm start          # http://localhost:3000
npm run smoke      # engine smoke test
```
