# Polymarket BTC/ETH UP/DOWN — Dual-Engine Ladder Bot (5m + 15m)

Runs **two independent engines** (5-minute and 15-minute BTC/ETH UP/DOWN
windows) with **separate capital**. Both engines use the **same DUAL_LADDER
strategy** — every entry is a **resting limit order**. **Paper trading only**
— the bot reads live midpoint prices and simulates fills; it never holds a
wallet, private key, or real funds.

There is **no stop loss and no cutoff time** — filled shares ride to
resolution, and unfilled rungs simply expire at window close.

## Strategy (identical for 5m and 15m)

1. **Immediately at window open**, place **two resting buy-limit ladders** —
   one for **UP**, one for **DOWN** — at rungs **0.40, 0.35, 0.30, 0.25,
   0.20, 0.15, 0.10**. Each rung buys a **fixed 50 shares** regardless of
   dollar cost (`cost = 50 × rung price`, filled **at** the rung price as
   a maker fill).
2. **Fill rule**: a rung fills the moment its side's price trades at or
   below the rung price. All crossed rungs fill (highest first), even in
   the same tick.
3. **Cross-cancel rule**: the instant a rung fills on one side, the
   opposite side's **same-price** rung is cancelled (e.g. UP 0.40 fills →
   DOWN 0.40 is cancelled). Every other rung on both ladders stays live
   and independent.
4. **No cutoff** — rungs rest until the window closes. Unfilled rungs are
   never positions and cost nothing.
5. **Resolution** — the winning side pays **$1/share**, the losing side
   pays **$0**. Profit = (winning-side shares × $1) − total cost of all
   filled rungs.

Max exposure per window: **2 sides × 7 rungs × 50 shares = 700 shares**, up to **$175** (100 × Σ rungs) at the current rung set.

Example: UP 0.40 fills (50 shares, $20) and UP 0.30 fills later (50
shares, $15). UP wins → payout 100 shares → **+$65 profit**; UP loses →
**−$35**.

## Fees & rebates (Polymarket docs, Crypto category)

- **All ladder fills are resting (maker) fills**: makers are never charged
  fees, and the crypto maker rebate is **20% of the fee-equivalent**,
  credited on fill (`ENTRY_IS_MAKER: true`).

## Skip-filter learning (what-if tracking only)

The bot keeps trading as configured — but the dashboard also replays the
resolved windows and shows **what P&L would have been** if, after **N
consecutive FULL-ROUND wins**, the bot had skipped the **next N windows**:

| Filter | Rule |
|---|---|
| 1w1s | after 1 full-round win, skip the next 1 window |
| 2w2s | after 2 consecutive full-round wins, skip the next 2 windows |
| 3w3s | after 3 consecutive full-round wins, skip the next 3 windows |
| 4w4s | after 4 consecutive full-round wins, skip the next 4 windows |

- A **full-round win** = all ladder rungs (7) filled in that window AND
  the window settled with P&L ≥ 0.
- Skipped windows contribute nothing to that filter's P&L; skipped
  windows don't count as wins or losses. After a skip completes, the win
  counter resets and the cycle repeats.
- Any window that isn't a full-round win (partial fills, or a loss)
  resets the streak. No-trade windows are ignored.
- Shown per engine (5m / 15m separately) with Net P&L, windows traded,
  windows skipped, and full-round wins — compared side by side with the
  actual bot results. Tune `SKIP_FILTERS` in `config.js`.

## Trackers (per engine)

- **Streak** — current consecutive wins / losses (only traded windows
  count).
- **Peak capital** — all-time highest resolved bankroll.
- **Max drawdown** — worst peak-to-trough decline ever recorded at a
  resolution, in `$` and `%` of the peak.
- **Current drawdown** — live peak-to-equity distance (includes unrealized
  P&L).
- **Equity curve** — one realized-equity point per resolved window,
  charted on the dashboard.
- **Ladder view** — live rung grid per engine: filled / resting /
  cross-cancelled rungs, plus max ladder risk.

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
- `SKIP_FILTERS`: what-if skip rules for the learning table (`[1, 2, 3, 4]`)
- `LADDER_RUNGS`: rung prices, highest first (default `0.40 … 0.10`)
- `RUNG_SHARES`: fixed shares per rung (**50**)
- `ENGINES`: one block per engine (`'5m'` and `'15m'`), each with:
  - `WINDOW_MINUTES`: window length for that engine
  - `CAPITAL`: that engine's starting bankroll (independent)
- `BASE_TAKER_FEE_RATE` / `MAKER_REBATE_RATE` / `ENTRY_IS_MAKER`: fee model
  (maker fills: `ENTRY_IS_MAKER: true`)
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
the live **ladder grid** (filled / resting / cross-cancelled rungs per
side), win/loss streaks, **peak capital, max drawdown and current
drawdown**, an **equity curve chart**, unrealized P&L on open positions,
and per-engine resolution history.

## Status / safety

- `DEMO_MODE: true` (default) — paper trading only.
- There is **no live order-placement path** in this codebase yet. Going real
  is a separate, higher-stakes step: real wallet, real funds, and real
  slippage/latency risk.
