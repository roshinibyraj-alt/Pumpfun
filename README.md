# Polymarket BTC UP/DOWN — LEADER Bot (15m)

A **single 15-minute engine** running the **LEADER strategy** — buy the
**non-dipping side**. **Paper trading only** — the bot reads live midpoint
prices and simulates fills; it never holds a wallet, private key, or real
funds.

## Strategy

1. **Triggers**: while a 15-minute window is open, the bot watches both
   sides' midpoints. The **first time** a side's price is observed **at or
   below** a trigger level (`0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10`),
   it buys the **opposite (leader) side** — **50 fixed shares** per
   trigger. Each side+level can trigger at most once per window; no
   cutoff — triggers stay armed until the window closes. No new
   entries in the **last 60 seconds** of a window (`ENTRY_CUTOFF_SEC`)
   — a taker buy in the final minute has no time to recover.
2. **Execution (taker, v31)**: fills are **immediate** — on trigger the
   bot takes the market at the fresh leader mid plus realistic slippage
   (`TAKER_SLIPPAGE_MIN/MAX`: fills can be better or worse than the
   observed mid). Order-placement latency is still measured in ms with a
   real Polymarket round-trip. Every fill pays the crypto **taker fee**
   (`shares × 0.07 × price × (1 − price)`); stop-loss exits pay it too.
   Set `ENTRY_MODE: 'maker'` to restore the v30 behavior (resting limit
   at the mirror price with walk-through confirmation, no fees, 20%
   maker rebate).
3. **Stop loss**: any filled entry whose side's mid walks down to
   `LEADER.STOP_LOSS_PRICE` (`0.50`) is sold at `0.50` immediately
   (realized, no re-entry).
4. **Resolution**: the winning side pays **$1/share**, the losing side
   pays **$0**. Fills ride to resolution; profit =
   `(winning-side shares × $1) − total cost − taker fees`.

Max exposure per window: **2 sides × 7 levels × 50 shares = 700 shares**.

## Fees

- **Taker (v31)**: fee = `shares × 0.07 × price × (1 − price)` on every
  fill (entries and stop-loss exits). No maker rebate.
- **Maker (v30)**: makers never pay fees and earn a **20% of the
  fee-equivalent** rebate — only in maker mode.

## Dashboard

- **Live engine**: bankroll, return, unrealized/equity, live UP/DOWN
  prices, streaks, peak capital, max drawdown, equity curve, order
  latency, and a trigger grid showing executed/expired fills.
- **Learn panel**: LEADER backtest on real Polymarket price history —
  both the taker (live) and maker (v30) execution models, with P&L, win
  rate, and per-level leader edge. Refreshes on boot
  (`npm run learn` to force).

## Run

```bash
npm install
npm start          # dashboard on :3000 + bot loop
npm run learn      # refresh the backtest data
```

## Config

All knobs live in `config.js` — engine capital, trigger levels, shares
per trigger, execution mode, slippage band, stop loss, poll interval.
Railway redeploys automatically when you push to GitHub.
