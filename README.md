# Polymarket BTC/ETH UP/DOWN — Dual-Engine Paper Trading Bot (5m dip-recovery + 15m expensive/SL-recovery)

Runs **two independent engines** (5-minute and 15-minute BTC/ETH UP/DOWN
windows) with **separate capital** and **different strategies**. **Paper
trading only** — the bot reads live midpoint prices and simulates fills; it
never holds a wallet, private key, or real funds.

## 5m engine — DIP_RECOVERY

| Step | Rule |
|---|---|
| Monitor | first 120s, record the last moment each side is below 0.50 |
| Target | side whose most recent sub-0.50 dip was latest; no dip → no trade |
| Entry | after 120s, when the target returns to 0.50 → buy **$100 worth** (`shares = floor($100 / price)`) |
| Stop loss | 0.20 — exit at 0.20 if hit; otherwise ride to resolution |

## 15m engine — EXPENSIVE_RECOVERY

| Step | Rule |
|---|---|
| Entry | at/after 420s (7 min), buy **300 shares** on the **expensive side at any price** |
| Stop loss | **0.40 on every bet** — exit at 0.40 if hit; the 0.40 point is also the trigger for the next recovery |
| Loss calc | right after entry: `L = (fill − 0.40) × 300 + fee` |
| Recovery 1 | the moment the main hits 0.40, exit it and buy the **opposite side**, sized from the main's SL loss **+ 50 extra shares**: `shares = ceil(L / ((1 − p) × (1 − 0.07p))) + 50` |
| Recovery 2 | the moment recovery 1 hits 0.40, exit it and buy the **opposite side**, sized **only from recovery 1's loss** + 50 extra shares (never the main or earlier bets) |
| No carry | if recovery 2 also loses, the loss is **accepted** — nothing carries to the next window; every 15m window starts fresh with a new main entry. Max 3 bets per window. |

Every fill is modeled as a taker fill at the current midpoint:
`cost = shares × price + fee`, with `fee = shares × 0.07 × price × (1 − price)`
(Polymarket Crypto category). Stops exit at exactly their level (0.20 / 0.40).

## Bankroll

- Each engine starts with its own **$1,000 virtual** bankroll (`CAPITAL` in
  `config.js` under `ENGINES`). Money is never shared between the 5m and 15m
  engines.
- The 15m engine's `recoveryCarry` field is kept at 0 (losses are accepted
  inside the window; nothing rolls between windows).
- Per-engine state (bankroll, open window, pending resolutions, history) is
  persisted to `state.json`.
- Railway's filesystem is ephemeral — state resets on redeploy unless you add
  a persistent volume.

## Configuration (`config.js`)

Everything is tuned in `config.js` — edit, commit, and Railway redeploys:

- `ASSET`: `'btc'` or `'eth'`
- `ENGINES`: one block per engine (`'5m'` and `'15m'`), each with:
  - `STRATEGY`: `'DIP_RECOVERY'` (5m) or `'EXPENSIVE_RECOVERY'` (15m)
  - `WINDOW_MINUTES`: window length for that engine
  - `CAPITAL`: that engine's starting bankroll (independent)
  - 5m: `MONITOR_SECS`, `DIP_LEVEL`, `RETURN_LEVEL`, `BUY_AMOUNT`,
    `STOP_LOSS_LEVEL`
  - 15m: `ENTRY_AFTER_SECS`, `ENTRY_SHARES`, `STOP_LOSS_LEVEL`,
    `RECOVERY_EXTRA_SHARES` (extra shares added to every recovery)
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
strategy state (monitor/target for 5m; entry/SL/recovery 1/2 for 15m),
unrealized P&L on open positions, and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
