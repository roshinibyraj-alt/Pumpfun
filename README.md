# BTC Cross-Venue Arb Demo

This is a **paper-only** BTC 5-minute cross-venue scanner for Polymarket and Predict.fun. It reads market data and simulates one-sided positions. It does not place orders and contains no wallet signing, private keys, or live-trading execution path.

## Paper strategy

For each outcome (UP and DOWN), compare the same outcome on both venues:

- A venue confirms the signal when its executable best bid is **$0.70 or higher**.
- The other venue is the lagging entry venue when its same-side best ask is **at least $0.60 and below $0.70**. The bot buys that same signalled outcome on the lagging venue.
- The starting demo bankroll is **$1,000**. The base stake is **1% of the bankroll** (initially $10); shares are sized from executable ask depth, and the stake budget includes entry fees.
- After each settled loss, the next stake is **3× the fixed base for that losing streak**: for a $10 base, $10 → $30 → $90. After a win, the loss multiplier resets and the base is recalculated as 1% of the updated bankroll. Break-even results leave the sequence unchanged.
- Only **one trade total per five-minute window** is allowed, across both outcomes and venues. There is no re-entry. If an earlier trade is still awaiting official settlement, new entries pause until its result establishes the correct martingale step. A stake that exceeds available demo capital, or cannot be filled from visible depth within the ask band, is skipped rather than reduced or overdrawn.
- New entries are not allowed at or after **270 seconds** into the five-minute window. A pending entry is canceled if modeled arrival would be at or after that cutoff.
- There is **no hard stop-loss**. An unclosed position remains open for official settlement at the holding venue's window close.
- Take profit triggers when the holding venue's best bid is **$0.99 or higher**. The paper model closes at exactly **$1.00 per share**, as requested.

The signal is a paper model, not guaranteed or risk-free arbitrage. Venue prices, fees, order-book depth, execution timing, and settlement rules can differ.

## Polling and simulated fills

- The scanner targets a **500 ms start-to-start read cycle** with no overlapping scans. Polymarket and Predict.fun books are read concurrently; the dashboard reports the target interval and recent cycle time.
- A signal is not filled at detection time. The bot waits for a modeled **500 ms base delay plus measured market-data request latency**, then requires fresh snapshots and rechecks the leader bid, same-side entry ask, and executable depth for the full scheduled stake within the ask band.
- If the signal disappears, a book is stale, the market match is unsafe, or the full stake is unavailable, the attempt is logged as missed and no position is recorded.
- Paper take-profit exits also wait through modeled latency and are rechecked at arrival. This model cannot reproduce queue position, hidden liquidity, exchange acknowledgements, or actual fills.
- HTTP 429 responses trigger an exponential pause (up to 30 seconds) instead of repeated requests.
- Railway stdout receives structured entry/exit lifecycle events and a compact scanner heartbeat every 30 seconds. The 500 ms scan cycles are not individually logged.
- Optional server variables: `ARB_POLL_MS` (500–5000 ms; default 500) and `ARB_PAPER_BASE_LATENCY_MS` (100–5000 ms; default 500). These affect paper simulation only.

## Dashboard and settlement

The dashboard shows separate UP and DOWN bid/ask books for each venue, visible depth, quote age, market details, match status, trigger prices, paper positions, demo capital, and realized/provisional P&L. If a market's outcomes cannot be safely mapped to the same five-minute UP/DOWN window, the scanner blocks entries.

An open position is marked provisionally from the bid on the venue where its shares are held. A stale or missing quote clears the provisional mark rather than carrying forward an old value. A TP may close the paper position early according to the simulated exit rule above. Otherwise the bot waits for the **exact holding venue's official market outcome** and settles only that venue's shares at $1 per winning share or $0 per losing share. It does not require the other venue to resolve and does not use the shared BTC benchmark to decide settlement.

Coinbase BTC-USD data is labeled as an internal diagnostic/provisional reference only. It does not trigger entries, exits, or official-settlement P&L.

Paper positions and event logs are stored in `data/arb-state.json` (or `ARB_STATE_PATH`). On first startup after this strategy update, the previously approved migration clears the old trade/event ledger and initializes the new $1,000 bankroll and martingale sequence. Set `RAILWAY_VOLUME_MOUNT_PATH` or `ARB_STATE_PATH` if a persistent Railway volume is available; otherwise Railway's filesystem may reset on redeploy.

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
