# Polymarket BTC 5m Up/Down Bot — paper trading

A single trading engine, paper-trading Polymarket's `btc-updown-5m-*`
markets with a simulated balance (**no real orders**) and a live
dashboard.

## Strategy

1. **Entry:** at window open, place TWO resting limit buy orders at
   once, both at **0.30** — one on UP, one on DOWN. Sizes are
   asymmetric: whichever side won the *previous* window gets **500
   shares** (the favorite), the other side gets **250 shares** (the
   underdog). Up wins → UP=500/DOWN=250 next window. Down wins →
   DOWN=500/UP=250. Whichever order fills first, the other is
   cancelled immediately — at most one open position per window. No
   filters, no sitting out on a run — every window with a known
   previous winner gets both orders. Only exception: the very first
   window ever (no prior winner yet) or one whose predecessor's outcome
   couldn't be determined.
2. **Exit:** take-profit at **0.99**, or hold to window close if TP
   isn't hit. **There is no stop loss** — a losing position always
   rides all the way to settlement ($0/share if it loses) rather than
   being cut early at a partial loss.
3. **Bet sizing:** fixed — always 500 shares on the favorite / 250 on
   the underdog, win or lose. **No martingale** — size never scales
   with results.
4. **Capital / bankruptcy stop:** the engine tracks one running demo
   balance, starting at **$2,000** (`STARTING_CAPITAL`). If a loss ever
   takes it below $0, the engine halts permanently — no further trades.

**Settlement:** every window is settled purely off the last observed
CLOB price for each side at the moment the window rolls over — whichever
side was priced higher wins, paying $1/share, and the other pays $0.
This is deliberately *not* checked against Polymarket's real resolution
oracle (that code path, `fetch_resolution` in `polymarket_client.py`, is
still there but unused) — it's simpler and fully deterministic, at the
cost of occasionally disagreeing with the real outcome if the last price
tick was noisy or a beat stale. `SETTLED_BY_PRICE` log entries record
which prices decided each window.

**This is a directional bet that outcomes are streak-prone** — betting
2x size on whichever side just won only pays off if wins cluster more
than chance. If 5-minute BTC windows are close to independent, there's
no real edge here, and a loss on the 500-share favorite costs twice as
much as a loss on the 250-share underdog would. Validate thoroughly in
paper mode before ever pointing this at real money.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing) + resolution API client
  paper_broker.py         trade log + fee calculator (no balance of its own -- see below)
  engine.py                the strategy: dual limit orders sized off previous winner, no martingale, no SL, capital tracking
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
- Confirm `get_price` is returning sane 0–1 values (check the Up/Down
  price readouts and the sparkline).

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
