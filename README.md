# BTC Cross-Venue Arb Demo

This repository runs a **paper-only** BTC 5-minute cross-venue scanner for Polymarket and Predict.fun. It reads public market data and records simulated pairs. It has no live order placement, wallet, private key, signing, or trading API path.

## Signal rule

- Compare both directions independently: buy Polymarket UP + Predict.fun DOWN, and Predict.fun UP + Polymarket DOWN.
- Trigger at most one simulated pair per direction per UTC 5-minute window.
- Each leg has a maximum **$100 total cash** budget, including that leg's estimated taker fee.
- The paper account starts with **$10,000**. Open pair cash is reserved from available demo capital; finalized P&L updates the balance, and the scanner will not open a pair larger than the remaining bankroll.
- Both legs use the same share quantity. Quantity is sized from current executable ask depth, never from midpoint or last-trade prices.
- Estimate fees at each consumed ask level: Polymarket `shares × 0.07 × price × (1 − price)`; Predict.fun `shares × 0.02 × min(price, 1 − price)`.
- Require at least **$0.10 net edge per matched share after fees and the safety margin**. The default additional safety margin is $0.01 per share; set `ARB_SAFETY_MARGIN_PER_SHARE` on the server to a non-negative value below $0.50 to adjust it.
- Reject stale books, insufficient depth, non-matching windows, ambiguous markets, and markets whose actual outcomes cannot safely map to exactly UP and DOWN. Titles alone never establish equivalence.

The signal is a paper model, not guaranteed or risk-free arbitrage. Cross-venue rules, oracle sources, fees, and settlement timing may differ.

## Polling and paper fills

- The scanner targets a **500 ms start-to-start read cycle** with no overlapping scans. Venue reads run concurrently; stable market metadata is cached so the loop focuses on the current books. The dashboard reports the target interval and recent cycle time.
- A paper signal is **not filled at detection time**. It waits for a modeled **500 ms base order-arrival delay plus each venue’s measured order-book request time**, then requires both books to have been received after their respective arrival times. At that point the bot recalculates equal-share size, visible ask-depth fills, fees, slippage, and the $0.10 net-edge rule from the newer books.
- If the post-delay books are stale, too far apart in time, too shallow, or no longer clear the edge threshold, the attempt is logged as missed and no position is recorded. HTTP 429 responses trigger an exponential pause (up to 30 seconds) rather than hammering a rate-limited endpoint.
- This remains a **paper fill model**, not a prediction of an actual exchange fill: it cannot model queue position, hidden liquidity, real order acknowledgements, or leg-specific partial-fill/unhedged exposure. It only records a pair when both refreshed books support the same executable share quantity.
- Railway stdout receives structured lifecycle events and a compact scanner heartbeat every 30 seconds. Heartbeats include each feed's health/quote age, the active window, scan timing, opportunity states, and pending official settlements; the 500 ms scan cycles themselves are not logged.
- Optional server variables: `ARB_POLL_MS` (500–5000 ms; default 500) and `ARB_PAPER_BASE_LATENCY_MS` (100–5000 ms; default 500). They affect only paper scanning/simulation, never live orders.

## Dashboard and venue-specific paper settlement

The dashboard shows separate UP and DOWN bid/ask books for each venue, visible depth, timestamps/age, market details, matching status, candidate pair costs, fees, simulated trades, demo capital, and P&L. If Predict returns a quote for an open market that cannot be matched to Polymarket's exact 5-minute window, the dashboard can still show that market's separate quotes, but labels it unmatched and keeps it out of the scanner.

While the five-minute window is open, any P&L estimate is explicitly provisional and based on the Coinbase reference feed. After close, the bot waits for **both exact venue markets** to publish confirmed results: Polymarket's closed binary market outcome prices and Predict.fun's resolved market outcome/status. It settles each leg independently at $1 per winning share and $0 per losing share, then subtracts the pair's actual simulated cash cost. If outcomes disagree, one leg can lose; both legs can lose. Coinbase is a display-only diagnostic and never finalizes P&L.

Window expiry is not the same as official resolution. A trade remains pending, its capital stays reserved, and it is excluded from realized P&L until both venues confirm their outcomes. Predict.fun's oracle resolution and challenge process can take hours or longer. Existing trades previously finalized from the shared benchmark are migrated back to pending and reconciled against the original venue windows; their former benchmark values are retained only as audit metadata. No paper state or starting capital is reset by this migration.

Paper trades and event logs are written to `data/arb-state.json` (or `ARB_STATE_PATH`). Set `RAILWAY_VOLUME_MOUNT_PATH` or `ARB_STATE_PATH` if a persistent Railway volume is available; otherwise Railway's filesystem may reset on redeploy.

## Data feeds and setup

- Polymarket market discovery: public Gamma endpoint; books: public CLOB read-only `GET /book`.
- Predict.fun markets: documented read-only `GET /v1/markets`; book: documented read-only `GET /v1/markets/{id}/orderbook`. Its order book is YES-side only; the NO side is derived by complementing prices at the market's `decimalPrecision` and swapping bid/ask sides.
- Predict.fun requires an API key for its mainnet read endpoints. In Railway, add `PREDICT_API_KEY` under the service's **Variables**. The key is read only by the server and is never included in API responses or browser code. Without it, Polymarket and the benchmark continue to work, but paired scanning remains disabled until Predict.fun books are available.
- The Coinbase Exchange ticker and 5-minute candles provide a clearly labeled provisional/diagnostic reference only; they are not used for arbitrage signals or final P&L.

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
