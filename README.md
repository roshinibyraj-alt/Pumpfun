# BTC Cross-Venue Arb Demo

This repository runs a **paper-only** BTC 5-minute cross-venue scanner for Polymarket and Predict.fun. It reads public market data and records simulated pairs. It has no live order placement, wallet, private key, signing, or trading API path.

## Signal rule

- Compare both directions independently: buy Polymarket UP + Predict.fun DOWN, and Predict.fun UP + Polymarket DOWN.
- Trigger at most one simulated pair per direction per UTC 5-minute window.
- Each leg has a maximum **$100 total cash** budget, including that leg's estimated taker fee.
- Both legs use the same share quantity. Quantity is sized from current executable ask depth, never from midpoint or last-trade prices.
- Estimate fees at each consumed ask level: Polymarket `shares × 0.07 × price × (1 − price)`; Predict.fun `shares × 0.02 × min(price, 1 − price)`.
- Require at least **$0.10 net edge per matched share after fees and the safety margin**. The default additional safety margin is $0.01 per share; set `ARB_SAFETY_MARGIN_PER_SHARE` on the server to a non-negative value below $0.50 to adjust it.
- Reject stale books, insufficient depth, non-matching windows, ambiguous markets, and markets whose actual outcomes cannot safely map to exactly UP and DOWN. Titles alone never establish equivalence.

The signal is a paper model, not guaranteed or risk-free arbitrage. Cross-venue rules, oracle sources, fees, and settlement timing may differ.

## Dashboard and paper finalization

The dashboard shows separate UP and DOWN bid/ask books for each venue, visible depth, timestamps/age, market details, matching status, candidate pair costs, fees, simulated trades, and P&L.

Paper P&L is provisional while the window is open. Once the exact UTC 5-minute window has ended and the corresponding Coinbase Exchange BTC-USD 5-minute candle is available, both paper legs are finalized against the **same internal benchmark** (`close >= open` means UP). That benchmark is not Polymarket's Chainlink BTC/USD TWAP, Predict.fun's market oracle, or an actual token payout. It is only a consistent model rule for demo accounting. Coinbase price/candle data is not used to detect arbitrage.

Only paper trades, event logs, and the minimum benchmark data needed to settle them are written to `data/arb-state.json` (or `ARB_STATE_PATH`). Set `RAILWAY_VOLUME_MOUNT_PATH` or `ARB_STATE_PATH` if a persistent Railway volume is available; otherwise Railway's filesystem may reset on redeploy.

## Data feeds and setup

- Polymarket market discovery: public Gamma endpoint; books: public CLOB read-only `GET /book`.
- Predict.fun markets: documented read-only `GET /v1/markets`; book: documented read-only `GET /v1/markets/{id}/orderbook`. Its order book is YES-side only; the NO side is derived by complementing prices at the market's `decimalPrecision` and swapping bid/ask sides.
- Predict.fun requires an API key for its mainnet read endpoints. In Railway, add `PREDICT_API_KEY` under the service's **Variables**. The key is read only by the server and is never included in API responses or browser code. Without it, Polymarket and the benchmark continue to work, but paired scanning remains disabled until Predict.fun books are available.
- The Coinbase Exchange ticker and 5-minute candles are used only for the paper benchmark at settlement time.

## Railway

The existing Railway build/start/healthcheck configuration is intentionally retained:

- Build: `PORT=4173 BASE_PATH=/ pnpm run build`
- Start: `pnpm start`
- Health check: `/api/healthz`

The Express server serves the dashboard and `/api/bot/state`, `/api/bot/start`, and `/api/bot/stop`. These controls start or stop **only the paper scanner**.

## Verification

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server test
pnpm run build
```
