# Polymarket BTC/ETH UP/DOWN — Dual-Engine (5m + 15m) Paper Trading Bot

Time-scheduled cheap/expensive buys on Polymarket's **5-minute and 15-minute**
BTC (or ETH) UP/DOWN markets, running as **two independent engines with
separate capital**. **Paper trading only** — the bot reads live midpoint prices
and simulates fills; it never holds a wallet, private key, or real funds.

## How it works

Two engines run at the same time, each on its own bankroll, schedule, and
history:

| Engine | Window | CHEAP side (lower midpoint) | EXPENSIVE side (higher midpoint) |
|---|---|---|---|
| 5m | 5 minutes | 50 shares @ 30s / 60s / 90s | 100 shares @ flip / +30s / +60s (fallback 150s / 180s / 210s) |
| 15m | 15 minutes | 50 shares @ 90s / 180s / 270s | 100 shares @ flip / +90s / +180s (fallback 570s / 660s / 750s) |

- **Flip-timed expensive buys:** after all 3 cheap buys are done, the bot
  watches the live sides. If the side that was cheap becomes the expensive
  side (a role flip), the expensive clock starts at **that flip moment** and
  the 3 buys fire at `flip`, `flip + interval`, `flip + 2 × interval` — the
  interval (5m: 30s, 15m: 90s) is counted from the **first expensive
  position**. If no flip happens, the fixed fallback times are used.
- "Cheap/expensive" is re-evaluated fresh from the live midpoints at each
  scheduled tick, so the side can flip between buys within a window.
- **Expensive-side price gate:** an expensive-side buy only fires while that
  side's midpoint is **below 0.90** (`EXPENSIVE_BUY_MAX_PRICE`). The bot keeps
  checking every tick through the buy's validity window; if the price never
  drops below 0.90, the buy is skipped for good — never chased at a bad price.
- Every buy is modeled as a taker fill at the current midpoint:
  `cost = shares × price + fee`, with `fee = shares × 0.07 × price × (1 − price)`
  (Polymarket Crypto category).
- Positions ride naked to real resolution — win = **$1/share**, lose = **$0**.
  No take-profit exits.
- A window resolves as soon as one side's price is ≥ 0.90 on the last tick
  before close; otherwise the bot polls the real market after close until it
  converges.

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
  - `CHEAP_ORDER_SHARES` / `EXPENSIVE_ORDER_SHARES`: bet sizes (default 50/100)
  - `CHEAP_BUY_AT_SECS` / `EXPENSIVE_BUY_AT_SECS`: buy schedule per engine
    (`EXPENSIVE_BUY_AT_SECS` doubles as the fixed fallback when no flip occurs)
  - `EXPENSIVE_BUY_INTERVAL_SECS`: spacing between the 3 expensive buys,
    counted from the first expensive position (flip moment)
  - `BUY_FIRE_VALIDITY_SECS`: how long after its scheduled second a buy may
    fire (so a mid-window restart doesn't dump all missed buys at once)
  - `EXPENSIVE_BUY_MAX_PRICE`: expensive-side buys only fire below this price
    (default 0.90)
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
prices, countdown, scheduled vs placed vs skipped buys, unrealized P&L on open
positions, and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
