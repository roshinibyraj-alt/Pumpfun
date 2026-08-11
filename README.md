# Polymarket BTC/ETH UP/DOWN — Dual-Engine Paper Trading Bot (5m + 15m dip + bucket)

Runs **two independent engines** (5-minute and 15-minute BTC/ETH UP/DOWN
windows) with **separate capital** and **separate buckets**. Both engines
use the **same dip-signal strategy** — the 15m is a proportional mirror of
the 5m (3× the window → 3× the monitor time and 3× the base bet). **Paper
trading only** — the bot reads live midpoint prices and simulates fills; it
never holds a wallet, private key, or real funds.

There is **no stop loss** — every entry rides to resolution, win or lose.

## Engine logic (identical for 5m and 15m)

| Step | 5m engine | 15m engine |
|---|---|---|
| Monitor | first **90s**, record the last moment each side is below 0.50 | first **270s** (3×), same rule |
| Target | side whose most recent sub-0.50 dip was latest; no dip → no trade | same |
| Entry | after monitor, when target returns to 0.50 → buy **$100** base + mini | buy **$300** base + mini (3×) |
| Exit | rides to resolution (win $1/share, or lose the cost) | same |

```
shares = floor(BUY_AMOUNT / price) + floor(miniBucket / price)
```

## Bucket filter (main + mini)

- Every **loss** adds its **full dollar loss** to that engine's **main
  bucket**, then re-splits it into a mini installment:
  `miniBucket = bucket ÷ BUCKET_DIVISOR (2)`.
- The **next window** bets **base + miniBucket**. Example: a $66 loss →
  main $66, mini $33; the next window wagers base + $33 worth.
- **ONE win** of a mini-bucket bet **clears the whole bucket** (main and
  mini go to 0).
- A **loss** adds its full loss to the main bucket and re-splits by 2
  again.
- No-trade windows leave both buckets untouched.
- The **5m and 15m buckets are fully independent** of each other.

## Trackers (per engine)

- **Streak** — current consecutive wins / losses (only traded windows
  count; no-trade windows don't change it).
- **Peak capital** — the all-time highest resolved bankroll (starts at the
  starting capital).
- **Max drawdown** — the worst peak-to-trough decline ever recorded at a
  resolution, in `$` and `%` of the peak at that time.
- **Current drawdown** — live peak-to-equity distance (includes unrealized
  P&L of the open position).
- **Equity curve** — one realized-equity point per resolved window,
  charted on the dashboard.

## Bankroll

- Each engine starts with its own **$1,000 virtual** bankroll (`CAPITAL` in
  `config.js` under `ENGINES`). Money is never shared between the 5m and
  15m engines.
- Per-engine state (bankroll, streak, peak/max-drawdown, open window,
  pending resolutions, history, equity curve) is persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you
  add a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `ENGINES`: one block per engine (`'5m'` and `'15m'`), each with:
  - `WINDOW_MINUTES`: window length for that engine
  - `CAPITAL`: that engine's starting bankroll (independent)
  - `MONITOR_SECS`: monitor phase (5m: 90, 15m: 270)
  - `DIP_LEVEL` / `RETURN_LEVEL`: dip threshold (0.50) and re-entry level
  (0.50)
- `BUCKET_DIVISOR`: 2 — the main bucket is split into this-sized mini
  installment; one win clears the whole bucket
  - `BUY_AMOUNT`: base notional (5m: $100, 15m: $300)
- `BASE_TAKER_FEE_RATE` / `MAKER_REBATE_RATE` / `ENTRY_IS_MAKER`: fee model
- `RESOLUTION_WIN_THRESHOLD` / `RESOLUTION_LOSS_THRESHOLD`
- `POLL_INTERVAL_MS`, `STATE_FILE`

## Run locally

```bash
npm install
npm start        # or: node server.js
```

Dashboard: http://localhost:3000 (set `PORT` to change).

## Deploy on Railway

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo.
3. Builds with Nixpacks; start command is `node server.js` (see `railway.json`).
4. Every push auto-redeploys with the new code.

## Dashboard

Shows each engine separately: bankroll/return/equity, live UP/DOWN prices,
strategy state (monitor/target/entry), the per-engine **main bucket + mini
installment (÷2)**, win/loss streaks, **peak capital, max drawdown and
current drawdown**, an **equity curve chart**, unrealized P&L on open
positions, and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
