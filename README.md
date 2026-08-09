# Polymarket BTC/ETH UP/DOWN — 15-Minute Paper Trading Bot

Time-scheduled cheap/expensive buys on Polymarket's **15-minute** BTC (or ETH)
UP/DOWN markets. **Paper trading only** — the bot reads live midpoint prices
and simulates fills; it never holds a wallet, private key, or real funds.

## How it works

Every 15-minute window (aligned to :00/:15/:30/:45) the bot places up to 6
simulated taker buys:

| When (sec after window open) | Side | Size |
|---|---|---|
| 90 / 180 / 270 | CHEAP (the side with the LOWER midpoint) | 50 shares each |
| 630 / 720 / 810 | EXPENSIVE (the side with the HIGHER midpoint) | 100 shares each |

- "Cheap/expensive" is re-evaluated fresh from the live midpoints at each
  scheduled tick, so the side can flip between buys within a window.
- Every buy is modeled as a taker fill at the current midpoint:
  `cost = shares × price + fee`, with `fee = shares × 0.07 × price × (1 − price)`
  (Polymarket Crypto category).
- Positions ride naked to real resolution — win = **$1/share**, lose = **$0**.
  No take-profit exits.
- A window resolves as soon as one side's price is ≥ 0.90 on the last tick
  before close; otherwise the bot polls the real market after close until it
  converges.

The schedule was scaled ×3 from the original 5-minute version (cheap 30/60/90s,
expensive 210/240/270s); **bet sizes are unchanged** (50/100 shares).

## Bankroll

- Starts at **$1,000 virtual** (`STARTING_BANKROLL` in `config.js`).
- One shared bankroll across all windows, persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you add
  a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `WINDOW_MINUTES`: `15`
- `CHEAP_ORDER_SHARES` / `EXPENSIVE_ORDER_SHARES`: bet sizes (default 50/100)
- `CHEAP_BUY_AT_SECS` / `EXPENSIVE_BUY_AT_SECS`: buy schedule
- `BUY_FIRE_VALIDITY_SECS`: how long after its scheduled second a buy may fire
  (so a mid-window restart doesn't dump all missed buys at once)
- `BASE_TAKER_FEE_RATE` / `MAKER_REBATE_RATE` / `ENTRY_IS_MAKER`: fee model
- `RESOLUTION_WIN_THRESHOLD` / `RESOLUTION_LOSS_THRESHOLD`
- `STARTING_BANKROLL`

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

Shows live bankroll, current window state, scheduled vs placed buys, unrealized
P&L on open positions, resolution history, and the bot log.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
