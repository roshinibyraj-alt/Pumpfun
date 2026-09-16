# Polymarket 9-Engine Bot (Paper / Demo Mode)

Nine independent trading engines, each with its own $500 bankroll
($4,500 total), all trading Polymarket's 5-minute BTC Up/Down market off
the same shared live order books but with completely separate logic,
positions, and balances. **This bot is paper-trading only** — it reads
Polymarket's real, public order books but never signs or submits a real
order.

## Engines 1–5: limit entry-cancel, skip-after-win with shadow monitoring

| Engine | Entry price | Skip length after a win |
|---|---|---|
| E1 | 0.10 | 5 windows |
| E2 | 0.20 | 4 windows |
| E3 | 0.30 | 3 windows |
| E4 | 0.40 | 2 windows |
| E5 | 0.50 | 1 window |

- At window open, resting limit buys (100 shares) on both Up and Down at
  the engine's price. Whichever fills first, the other is canceled — at
  most one position per window.
- **No stop-loss.** Take-profit at 0.99 sells everything at once.
- **After a real win**, the engine stops trading for real for N windows.
  During each skipped window it keeps running the identical logic as a
  **shadow trade** (no real money) purely to check: would this window
  have won?
  - Shadow win → skip counter **resets to N** (stays sidelined).
  - Shadow loss, or no fill at all that window → skip counter
    **decrements by 1**.
  - Counter reaches 0 → resumes real trading the next window.
- A window with literally no fill on either side (shadow mode) counts as
  "not a win" for this purpose — it decrements the counter rather than
  leaving it unchanged.

## Engines 6–9: momentum taker entries, fixed SL, no skip

| Engine | Trigger price | SL | TP |
|---|---|---|---|
| E6 | 0.60 | 0.20 | 0.99 |
| E7 | 0.70 | 0.30 | 0.99 |
| E8 | 0.80 | 0.40 | 0.99 |
| E9 | 0.90 | 0.50 | 0.99 |

- Whichever side (Up or Down) first rises to reach the trigger price is
  bought **immediately as a taker** — at the live ask observed at that
  moment (not clamped to the trigger price itself, since this is a real
  market buy, not a resting limit order). One entry per window.
- **Real stop-loss**: if price falls back to the SL level, sold for a
  genuine loss at that price (fees apply normally) — unlike E1-E5, this
  is not the special TP treatment.
- Take-profit at 0.99 uses the same universal rule as every engine (see
  below). If neither SL nor TP triggers, held to actual resolution.

## Universal take-profit rule

Per spec, hitting the take-profit trigger (0.99) is booked as a **clean
$1.00/share payout with no fee** — treated identically to a winning
resolution, not an actual market sale at 0.99. This applies to all 9
engines equally (`app/engine.py`, `close_take_profit`).

## Resolution (hold-to-close path)

Any position never closed via TP or SL is held to Polymarket's own
**official resolution** (Gamma's `closed` + `outcomePrices`), falling
back to the CLOB's actual last-traded price if Gamma hasn't confirmed
within `GAMMA_RESOLUTION_TIMEOUT_SECONDS` of window close — never
bid/ask/midpoint, which are unsafe right at window close (see
`app/clobbook.py` notes; this is the same resolution approach used
throughout this series of bots, carried forward as-is).

## Independence

Each of the 9 engines has its own `PaperLedger` (balance, history) and
its own runtime state (open position, skip counter, awaiting-resolution
queue) — nothing is shared or pooled between them. They only share the
read-only BTC order book snapshot fetched once per tick, purely for
efficiency (no point fetching the same book 9 times).

## Execution model

- Entries and stop-losses are booked at their own target price (the
  resting limit price for E1-E5, the live ask at trigger time for
  E6-E9, the SL level for a stop-out) rather than walking live order
  book depth — a simplifying convention consistent with prior bots in
  this series.
- Fees use Polymarket's real dynamic crypto taker-fee formula,
  `fee = shares * fee_rate * price * (1 - price)`, with the rate read
  live per-market from Gamma. Take-profit is the one exception — no fee,
  per the universal $1.00 rule above.

## Running locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Then open `http://localhost:8080` for the dashboard, or `GET /status`
for raw JSON.

## Deploying on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**. Railway will
   detect the `Dockerfile` automatically. If it doesn't, explicitly set
   **Builder → Dockerfile** in Settings → Build.
3. Set any env vars you want to override (see `.env.example`) in the
   Railway **Variables** tab.
4. **Attach a Volume mounted at `/data`** if you want balances/history/
   skip-counters to survive redeploys.
5. Deploy. Railway exposes a public URL serving the dashboard on `$PORT`.

## Project layout

```
app/
  config.py     # the 9 engine definitions (prices, SL, skip lengths) + shared params
  gamma.py      # Gamma API market discovery
  clobbook.py   # public CLOB order book + last-trade-price fetch
  fills.py      # fill simulation helper
  engine.py     # Position model + per-engine PaperLedger (real + shadow trades)
  strategy.py   # NineEngineBot: shared window/book fetch, per-engine tick logic, resolution
  storage.py    # SQLite persistence (balance + skip counter per engine, trade history)
  server.py     # FastAPI dashboard + /status JSON + /health
main.py         # runs the bot loop and web server together, colored per-engine logs
```

## Disclaimer

This is trading-adjacent software provided for experimentation. Nothing
here is financial advice. Nine engines running in parallel means nine
independent risk profiles — some of these (e.g. E1 at a 0.10 entry) are
inherently low-probability/high-payout, others (E9 at a 0.90 momentum
entry) are closer to a coin flip with tight risk bands. None of this is
a guarantee of profitability; it's a simulation of a specific rule set
against real market data.
