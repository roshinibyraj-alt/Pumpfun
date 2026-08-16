# Polymarket BTC UP/DOWN — LEADER Bot (5m)

A **single 5-minute engine** running the **LEADER strategy** — buy the
**non-dipping side**. **Paper trading only** — the bot reads live midpoint
prices and simulates fills; it never holds a wallet, private key, or real
funds. There is **no stop loss and no cutoff time**.

The 15m engine and the old dual-ladder strategy were removed in v26 —
LEADER is the only live strategy (it is the only variant that backtests
positive, see the Learn panel).

## Strategy

1. **Triggers**: while a 5-minute window is open, the bot watches both
   sides' midpoints. The **first time** a side's price is observed **at or
   below** a trigger level (`0.40, 0.35, 0.30, 0.25, 0.20, 0.15, 0.10`),
   it places a **buy-limit order on the opposite (leader) side** at that
   side's current mid — **50 fixed shares** per trigger (cost =
   `50 × limit price`). Each side+level can trigger at most once per
   window; no cutoff — triggers stay armed until the window closes.
2. **Fill confirmation**: fills are **not assumed**. Order placement
   latency is measured in **ms** with a real Polymarket round-trip, and
   only after that latency has elapsed does the bot check that the price
   has **walked through the order price** (leader mid ≤ limit). The fill
   is then confirmed at the limit price as a maker fill. Orders that never
   walk through expire unfilled at window close — no cost.
3. **Resolution**: the winning side pays **$1/share**, the losing side
   pays **$0**. Confirmed fills ride to resolution; profit =
   `(winning-side shares × $1) − total cost of all confirmed fills`.

Max exposure per window: **2 sides × 7 levels × 50 shares = 700 shares**,
up to **$175** at the current level set.

Example: UP dips to 0.40 → the bot places a buy-limit on DOWN at its mid
(e.g. 0.60, 50 shares = $30). If DOWN wins → payout 50 shares →
**+$20 profit**; DOWN loses → **−$30**.

## Fees & rebates (Polymarket docs, Crypto category)

- Confirmed fills are **resting (maker) limit fills**: makers are never
  charged fees, and the crypto maker rebate is **20% of the
  fee-equivalent**, credited on fill (`ENTRY_IS_MAKER: true`).

## Dashboard

- **Live engine**: bankroll, return, unrealized/equity, live UP/DOWN
  prices, streaks, peak capital, max drawdown, equity curve, order
  latency, and a trigger grid showing placed/confirmed/expired fills.
- **Learn panel**: LEADER backtest on real Polymarket price history
  (windows, P&L, win rate, per-level leader edge). Refreshes on boot
  (`npm run learn` to force).

## Run

```bash
npm install
npm start          # dashboard on :3000 + bot loop
npm run learn      # refresh the backtest data
```

## Config

All knobs live in `config.js` — engine capital, trigger levels, shares per
trigger, fill-confirmation minimum delay (`LEADER.CONFIRM_MS_MIN`), poll
interval. Railway redeploys automatically when you push to GitHub.
