# Polymarket BTC/ETH UP/DOWN — Dual-Engine Paper Trading Bot (5m + 15m dip-bucket)

Runs **two independent engines** (5-minute and 15-minute BTC/ETH UP/DOWN
windows) with **separate capital** and **separate buckets**. Both engines
use the **same DIP_RECOVERY logic** — the 15m is a proportional mirror of
the 5m (3× the window → 3× the monitor time and 3× the base bet). **Paper
trading only** — the bot reads live midpoint prices and simulates fills;
it never holds a wallet, private key, or real funds.

## Engine logic (identical for 5m and 15m)

| Step | 5m engine | 15m engine |
|---|---|---|
| Monitor | first **90s**, record the last moment each side is below 0.50 | first **270s** (3×), same rule |
| Target | side whose most recent sub-0.50 dip was latest; no dip → no trade | same |
| Entry | after monitor, when target returns to 0.50 → buy **$100** base + bucket/3 | buy **$300** base + bucket/3 (3×) |
| Stop loss | **0.20** — exit at 0.20 if hit | **0.20** (same) |

Entry sizing (both engines):

```
shares = floor(BUY_AMOUNT / px) + floor((bucket / 3) / px)
```

## Bucket filter (the main money filter)

- Every **stop-loss exit** or **resolution loss** adds its **full dollar
  loss** to that engine's bucket.
- The **next window** bets **base + bucket ÷ 3**.
- If that bet **loses again**, its full loss is added to the bucket and the
  next window again bets **base + bucket ÷ 3** (re-divided every time).
- If a bucket bet **wins**, the bucket **shrinks by the bucket third that
  was wagered** (the amount that bet recovered) — it does **not** reset to
  zero; it keeps shrinking on each win until clear.
- No-trade windows leave the bucket untouched.
- The **5m and 15m buckets are independent** of each other.

## Bankroll

- Each engine starts with its own **$1,000 virtual** bankroll (`CAPITAL` in
  `config.js` under `ENGINES`). Money is never shared between the 5m and
  15m engines.
- Each engine also tracks its own `bucket` (the unrecovered loss pool) in
  state.
- Per-engine state (bankroll, bucket, open window, pending resolutions,
  history) is persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you
  add a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `BUCKET_DIVISOR`: 3 — bucket ÷ 3 is added to the next window's base bet
- `ENGINES`: one block per engine (`'5m'` and `'15m'`), each with:
  - `WINDOW_MINUTES`: window length for that engine
  - `CAPITAL`: that engine's starting bankroll (independent)
  - `MONITOR_SECS`: monitor phase (5m: 90, 15m: 270)
  - `DIP_LEVEL` / `RETURN_LEVEL`: dip threshold and re-entry level (0.50)
  - `BUY_AMOUNT`: base notional (5m: $100, 15m: $300)
  - `STOP_LOSS_LEVEL`: 0.20 for both
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
strategy state (monitor/target/entry), the per-engine **bucket**, unrealized
P&L on open positions, and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
