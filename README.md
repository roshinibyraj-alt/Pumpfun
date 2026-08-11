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
| Entry | after monitor, when target returns to 0.50 → buy **$100** base + mini | buy **$300** base + mini (3×) |
| Stop loss | **0.20** — exit at 0.20 if hit | **0.20** (same) |

Entry sizing (both engines):

```
shares = floor(BUY_AMOUNT / px) + floor((bucket / 3) / px)
```

## Bucket filter (main + mini)

- Every **stop-loss exit** or **resolution loss** adds its **full dollar
  loss** to that engine's **main bucket**, then re-splits it into a fixed
  installment: `miniBucket = bucket ÷ 3`.
- The **next window** bets **base + miniBucket**. Example: a $66 loss → main
  $66, mini $22; the next three windows each wager the same $22.
- A **win** deducts exactly **one mini** from the main bucket ($66 → $44 →
  $22 → $0), so **3 consecutive wins clear** the main bucket. The mini does
  NOT shrink after a win.
- A **loss** adds its full loss to the main bucket and re-splits:
  `main = main + loss; mini = main ÷ 3`.
- No-trade windows leave both buckets untouched.
- The **5m and 15m buckets are fully independent** of each other.
- Tracked live per engine: current **win/loss streak** (consecutive,
  only traded windows count), **bucket clears** (how many times the main
  bucket fully cleared), and the **consecutive wins it took** for the most
  recent clear.
- A full **equity curve** (one realized-equity point per resolved window)
  is recorded per engine and charted on the dashboard.

## Bankroll

- Each engine starts with its own **$1,000 virtual** bankroll (`CAPITAL` in
  `config.js` under `ENGINES`). Money is never shared between the 5m and
  15m engines.
- Each engine also tracks its own `bucket` (main bucket) and `miniBucket`
  (the fixed installment) in state.
- Per-engine state (bankroll, bucket, open window, pending resolutions,
  history) is persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you
  add a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `BUCKET_DIVISOR`: 3 — the main bucket is split into this many fixed mini
  installments
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
strategy state (monitor/target/entry), the per-engine **main bucket + mini
installment**, win/loss streaks + bucket-clear stats, an **equity curve
chart**, unrealized P&L on open positions, and per-engine resolution
history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
