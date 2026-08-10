# Polymarket BTC/ETH UP/DOWN — Dual-Engine Dip-Recovery Paper Trading Bot

Runs **two independent engines** (5-minute and 15-minute BTC/ETH UP/DOWN
windows) with **separate capital**, following the same dip-recovery rule on
their own window length. **Paper trading only** — the bot reads live midpoint
prices and simulates fills; it never holds a wallet, private key, or real
funds.

## How it works

| Engine | Window | Monitor phase | Entry trigger | Size | Stop loss |
|---|---|---|---|---|---|
| 5m | 5 minutes | first 120s | after 120s | $100 worth | $0.20 |
| 15m | 15 minutes | first 420s | after 420s | $100 worth | $0.20 |

Per window, each engine:

1. **Monitors** both sides continuously during the monitor phase and records
   the LAST moment each side's midpoint is below `DIP_LEVEL` (0.50).
2. **Picks the target** — the side whose most recent sub-0.50 dip happened the
   latest. If neither side ever dips below 0.50, no trade that window.
3. **Enters** — any time after the monitor phase, once the target side's price
   comes back to `RETURN_LEVEL` (0.50), it buys **$100 worth** of shares:
   `shares = floor($100 / price)` filled at the current mid. One buy per
   window. If the target never returns to 0.50, no trade.
4. **Stop loss** — if the bought side's price hits `STOP_LOSS_LEVEL` (0.20),
   the bot exits at 0.20 and realizes the loss immediately. Otherwise the
   position rides to real resolution (win = **$1/share**, lose = **$0**).

Every fill is modeled as a taker fill at the current midpoint:
`cost = shares × price + fee`, with `fee = shares × 0.07 × price × (1 − price)`
(Polymarket Crypto category). Stops exit at exactly 0.20.

## Bankroll

- Each engine starts with its own **$1,000 virtual** bankroll (`CAPITAL` in
  `config.js` under `ENGINES`). Money is never shared between the 5m and 15m
  engines.
- Per-engine state (bankroll, open window, pending resolutions, history) is
  persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you add
  a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `ENGINES`: one block per engine (`'5m'` and `'15m'`), each with:
  - `WINDOW_MINUTES`: window length for that engine
  - `CAPITAL`: that engine's starting bankroll (independent)
  - `MONITOR_SECS`: monitor phase length (5m: 120s, 15m: 420s)
  - `DIP_LEVEL`: a side "dipped" while its price is below this (0.50)
  - `RETURN_LEVEL`: buy when the target returns to this (0.50)
  - `BUY_AMOUNT`: notional size of the single buy ($100)
  - `STOP_LOSS_LEVEL`: exit price if the position moves against you (0.20)
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

Shows each engine separately: its own bankroll/return/equity, live UP/DOWN
prices, monitor phase status, target side, entry status, stop-loss state,
unrealized P&L on open positions, and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
