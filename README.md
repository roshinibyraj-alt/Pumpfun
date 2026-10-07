# BTC Cross-Venue Arb Demo

This is a **paper-only** BTC 5-minute cross-venue scanner for Polymarket and Predict.fun. It reads market data and simulates one-sided positions. It does not place orders and contains no wallet signing, private keys, or live-trading execution path.

## Paper strategy

For each outcome (UP and DOWN), compare the same outcome on both venues:

- A venue confirms the signal when its executable best bid is **$0.90 or higher**.
- The other venue is the lagging entry venue when its best ask is **at least $0.40 and below $0.70**. The bot buys only that same-side outcome on the lagging venue.
- Each entry is **500 shares**, sized from visible ask depth. If the full quantity is not executable within the entry band, no position is simulated.
- New entries are not allowed at or after **270 seconds** into the five-minute window. A pending entry is canceled if modeled arrival would be at or after that cutoff.
- The hard stop triggers when the holding venue's best bid is **$0.30 or lower**. After modeled latency, the simulated exit consumes visible bid depth and deducts the venue's taker fees.
- Take profit triggers when the holding venue's best bid is **$0.99 or higher**. The paper model closes at exactly **$1.00 per share**, as requested.
- Allow one re-entry per side in a window, only after the first position exits and the entry signal has cleared and then appeared again. That means at most two entries per side per five-minute window.
- The demo account starts with **$10,000**. Entry cost is reserved from available capital; exits and official settlement update realized paper P&L.

The signal is a paper model, not guaranteed or risk-free arbitrage. Venue prices, fees, order-book depth, execution timing, and settlement rules can differ.

## Polling and simulated fills

- The scanner targets a **500 ms start-to-start read cycle** with no overlapping scans. Polymarket and Predict.fun books are read concurrently; the dashboard reports the target interval and recent cycle time.
- A signal is not filled at detection time. The bot waits for a modeled **500 ms base delay plus measured market-data request latency**, then requires fresh snapshots from both venues and rechecks the entry prices and 500-share depth.
- If the signal disappears, a book is stale, the market match is unsafe, or the full quantity is unavailable, the attempt is logged as missed and no position is recorded.
- Paper exits also wait through modeled latency. TP is rechecked at arrival; stop-loss exits use the then-visible bid depth and fees. This model cannot reproduce queue position, hidden liquidity, exchange acknowledgements, or actual fills.
- HTTP 429 responses trigger an exponential pause (up to 30 seconds) instead of repeated requests.
- Railway stdout receives structured entry/exit lifecycle events and a compact scanner heartbeat every 30 seconds. The 500 ms scan cycles are not individually logged.
- Optional server variables: `ARB_POLL_MS` (500–5000 ms; default 500) and `ARB_PAPER_BASE_LATENCY_MS` (100–5000 ms; default 500). These affect paper simulation only.

## Dashboard and settlement

The dashboard shows separate UP and DOWN bid/ask books for each venue, visible depth, quote age, market details, match status, trigger prices, paper positions, demo capital, and realized/provisional P&L. If a market's outcomes cannot be safely mapped to the same five-minute UP/DOWN window, the scanner blocks entries.

An open position is marked provisionally from the bid on the venue where its shares are held. A stale or missing quote clears the provisional mark rather than carrying forward an old value. A TP or stop closes the paper position according to the simulated exit rules above. If it remains open at expiry, the bot waits for the **exact holding venue's official market outcome** and settles only that venue's shares at $1 per winning share or $0 per losing share. It does not require the other venue to resolve and does not use the shared BTC benchmark to decide settlement.

Coinbase BTC-USD data is labeled as an internal diagnostic/provisional reference only. It does not trigger entries, exits, or official-settlement P&L.

Paper positions and event logs are stored in `data/arb-state.json` (or `ARB_STATE_PATH`). Set `RAILWAY_VOLUME_MOUNT_PATH` or `ARB_STATE_PATH` if a persistent Railway volume is available; otherwise Railway's filesystem may reset on redeploy.

## Read-only data feeds

- Polymarket: public Gamma market discovery and public CLOB `GET /book` order books.
- Predict.fun: documented read-only `GET /v1/markets` and `GET /v1/markets/{id}/orderbook`. Predict's book is YES-side only; NO quotes are derived using the market's documented decimal precision and complementary bid/ask levels.
- Predict.fun requires a server-side `PREDICT_API_KEY` for its mainnet read endpoints. Add it under the Railway service's **Variables**. It is never returned to the browser. Without it, Predict quotes and cross-venue scanning remain unavailable; Polymarket data and the dashboard still work.

## Railway

The existing Railway build/start/healthcheck configuration is retained:

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
