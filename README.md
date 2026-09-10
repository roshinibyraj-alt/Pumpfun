# Polymarket BTC 5m Up/Down Bot — paper trading

A single trading engine, paper-trading Polymarket's `btc-updown-5m-*`
markets with a simulated balance (**no real orders**) and a live
dashboard.

## Strategy

A dual-sided price-level ladder, **maker-only**, with Polymarket's real
merge/redeem mechanic as the only exit.

1. **Entry:** each tick, for **both UP and DOWN independently**, look
   at the current best bid. Price levels run **0.10 to 0.95** in
   **0.01** steps (Polymarket's real tick size), and **each level
   trades at most once per side per window**. If the best bid sits at
   a level not yet used, place a **resting** 10-share buy order there
   — a pure maker order, never crossing the spread. It fills later, on
   a subsequent tick, if the market's ask trades down to that price —
   and earns the maker rebate when it does.

   No filters, no sizing based on any previous window's outcome — this
   runs the same way on every window, independently on each side.

   **Why maker-only, deliberately:** an earlier version of this engine
   also bought at the current ask (an instant, spread-crossing fill).
   In a real two-sided market, `ask_up + ask_down` normally sits
   **above $1.00** — that gap is the spread/vig — so crossing the
   spread on both sides and merging meant paying more than $1 to
   redeem $1: a guaranteed loss, which is exactly why that version
   consistently lost money. `bid_up + bid_down` normally sits **below
   $1.00**, the mirror image, so filling only at the bid on both sides
   and merging locks in that spread as *profit* instead of paying it
   away — on top of the maker rebate earned on every fill.

2. **Exit: merging.** Since exactly one of UP/DOWN pays $1 at
   resolution and the other pays $0, one UP share + one DOWN share is
   worth a guaranteed $1 combined at any time via Polymarket's real
   merge/redeem mechanic. **Whenever UP and DOWN inventory are both
   greater than zero, the matched quantity is merged and redeemed
   immediately.** That merge *is* the exit — there's no take-profit
   price and **no stop loss**.
3. **Leftover inventory:** if fills on the two sides don't land in
   equal size, whatever's left unmatched when the window closes rides
   to resolution — $1/share if that side won, $0 if it lost. Any
   still-resting (unfilled) orders are cancelled at window close.
4. **Capital / bankruptcy stop:** the engine tracks one running demo
   balance, starting at **$2,000** (`STARTING_CAPITAL`), debited on
   every fill and credited on every merge/resolution settlement. If it
   ever drops below $0, the engine halts permanently — no further
   trades.

**Settlement (for leftover inventory):** every window is settled purely
off the last observed CLOB midpoint for each side at the moment the
window rolls over — whichever side was priced higher wins, paying
$1/share, and the other pays $0. This is deliberately *not* checked
against Polymarket's real resolution oracle (that code path,
`fetch_resolution` in `polymarket_client.py`, is still there but
unused) — it's simpler and fully deterministic, at the cost of
occasionally disagreeing with the real outcome if the last price tick
was noisy or a beat stale. `SETTLED_BY_PRICE` log entries record which
prices decided each window.

**This is a market-making strategy, not a directional one** — profit
comes from the bid-side spread (`bid_up + bid_down < $1`) plus the
maker rebate, not from predicting which side wins. The real risks are
(a) never accumulating a matched pair at all if the book gaps past
levels instead of trading down through them (a resting bid simply never
fills if the market never reaches it), and (b) leftover one-sided
inventory eating a full loss at resolution if the two sides don't fill
evenly. Validate thoroughly in paper mode before ever pointing this at
real money.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing, order book) + resolution API client
  paper_broker.py         trade log + fee calculator (no balance of its own -- see below)
  engine.py                the strategy: maker-only dual-sided price-level ladder, merge-as-exit, capital tracking
  state.py                 background polling loop + orchestration
  main.py                  FastAPI app (serves API + dashboard)
static/index.html          dashboard UI
```

**One balance, one place:** `engine.py` is the single source of truth
for the demo-capital balance. An earlier version of this bot had the
paper broker track a second, separate balance in parallel — nothing
ever fed trades into it, so it sat frozen at its starting value and
never showed up meaningfully on the dashboard. That's gone now:
`paper_broker.py` only logs trades and computes fees; the "Demo
Capital" number on the dashboard is exactly `engine.s.balance`.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

Open http://localhost:8000

## Deploy: GitHub → Railway

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: BTC 5m paper trading bot"
   git branch -M main
   git remote add origin <your-repo-url>
   git push -u origin main
   ```
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
   Railway auto-detects Python via Nixpacks and uses the `Procfile` /
   `railway.json` start command — no manual build config needed.
3. Under **Variables**, set any of the values from `.env.example` you
   want to override (defaults work out of the box for paper mode).
4. Deploy. Railway assigns a public URL — that's your dashboard.

## Important: verify the Polymarket API responses once live

`app/polymarket_client.py` isolates all HTTP calls to Polymarket's
public Gamma (metadata) and CLOB (pricing) APIs. Field names on these
endpoints have shifted before. After your first deploy:

- Confirm `fetch_market_by_slug` is returning a market for the current
  `btc-updown-5m-<openTimestamp>` slug (check the dashboard header —
  if it says "waiting for window…" the slug/lookup needs a tweak).
- Confirm `get_book` is returning sane, non-crossed bid/ask values
  (bid ≤ ask, both 0–1) — check the Bid/Ask readouts on the dashboard.
  This is what the strategy actually trades off; if `/book` responses
  ever come back oddly shaped, that's the one function to fix.

If either is off, the fix is contained entirely to that one file — the
engine, broker, and dashboard don't touch raw API responses.

## Going live (real orders)

This build intentionally stops at paper trading. To route real orders:
- Add `py-clob-client`, an EOA wallet with USDC/MATIC on Polygon, and
  Polymarket API credentials (key/secret/passphrase).
- Replace the simulated fills in `engine.py` (`_fill_entry` / `_close`)
  with real `create_order` / `post_order` calls and real order-status
  polling (market orders aren't guaranteed to fill at the exact print
  you observed).
- Add slippage/fee handling and a kill switch before risking capital.
- Decide deliberately whether you want a stop loss in the live version
  — this paper build intentionally doesn't have one, per your request,
  but that's a real risk tradeoff worth revisiting before real capital
  is on the line.
