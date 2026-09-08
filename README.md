# Polymarket BTC 5m Up/Down Bot — paper trading

A single trading engine, paper-trading Polymarket's `btc-updown-5m-*`
markets with a simulated balance (**no real orders**) and a live
dashboard.

## Strategy

1. **Entry filter (streak-based):** at window open, place a resting
   limit buy at **0.30** on ONLY the side that won the *previous*
   window. If that side has won **3** windows in a row, sit out
   entirely and wait for a reversal — that flip starts a new streak and
   trading resumes the following window.
2. **Exit:** take-profit at **0.99**, or hold to Polymarket's real
   resolution if TP isn't hit by window close. **There is no stop
   loss** — a losing position always rides all the way to settlement
   ($0/share if it loses) rather than being cut early at a partial
   loss. This makes each loss more expensive than it would be with an
   SL; it does not change how often either side wins.
3. **Bet sizing (martingale):** a loss multiplies the next traded
   window's bet by **1.7×**; a win resets it to the base bet of **$30**.
   Windows with no trade (streak filter, or price never reached entry)
   don't move the ladder.
4. **Capital / bankruptcy stop:** the engine tracks one running demo
   balance, starting at **$2,000** (`STARTING_CAPITAL`). If a loss ever
   takes it below $0, the engine halts permanently — no further trades.

Every window is settled against Polymarket's real outcome (via
`fetch_resolution`, with a short retry + last-price fallback — see the
"resolution" section below), which pays $1/share on the winning side
and $0 on the losing side.

**Because there's no stop loss, the martingale ladder is the dominant
source of tail risk here** — a multi-window losing streak on a fixed
side gets expensive fast. Watch `max_losing_streak` on the dashboard
and validate thoroughly in paper mode before ever pointing this at real
money.

## Project layout

```
app/
  config.py             strategy + runtime parameters
  models.py              shared dataclasses/enums
  polymarket_client.py   Gamma (market discovery) + CLOB (pricing) + resolution API client
  paper_broker.py         trade log + fee calculator (no balance of its own -- see below)
  engine.py                the strategy: streak entry, martingale, no SL, capital tracking
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
