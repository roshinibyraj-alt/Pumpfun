# BTC 5m Rung Bot — Polymarket (Paper Trading)

Simulated market-making bot for Polymarket's BTC 5-minute up/down markets
(`btc-updown-5m-<epoch>`). Runs 4 independent "rungs," each resting limit
orders on both the UP and DOWN token, with a martingale-style size ladder
that steps down on wins and resets on losses.

**This build is paper trading only.** It never signs or sends a real
order — no private key, no CLOB API key, nothing to leak. All prices come
from Polymarket's public, no-auth Gamma/CLOB endpoints; fills are
simulated locally. Wire in a real broker later (see `app/engine.py`) once
you're ready to trade live — that's a deliberate, separate step.

## Strategy, exactly as specified

- **Discovery**: window slugs are deterministic — `btc-updown-5m-<epoch>`
  where `epoch` is a clean multiple of 300s. The bot computes the current
  and next window slug from the clock, no scraping needed.
- **Rungs**: 0.40, 0.35, 0.30, 0.25. At window open, each rung places a
  resting limit order on **both** UP and DOWN at its price, sized at that
  rung's current size (500 shares at first).
- **Fill logic**: a rung's order is simulated as filled when the token's
  live ask price touches its limit price. Whichever side fills first
  cancels the other side's resting order for that rung.
- **Cutoff**: at 270s into the 5-minute window, any still-resting orders
  are cancelled — no new fills allowed after that.
- **Settlement**: in the last 2 seconds of the window, whichever side's
  price is above 0.95 is the winner ($1); if neither crosses 0.95, the
  higher of the two prices wins (your chosen tie-break).
- **Sizing**: per rung, independently —
  - Win → next size = `max(100, current − 100)` (500→400→300→200→100, floor 100)
  - Loss → next size resets to 500
  - No fill → size unchanged
  - Cost varies with price and size; the ladder itself only ever moves in
    100-share steps.
- **Capital**: each rung tracks its own $5,000 paper bankroll — totally
  separate P&L, streaks, and win rate per rung.

## Project layout

```
app/
  config.py            all tunable constants
  models.py             RungState / WindowState / SimOrder / TradeRecord
  polymarket_client.py  Gamma + CLOB read-only client (no auth)
  engine.py              window lifecycle, fill simulation, settlement
  main.py                 FastAPI app, REST snapshot, websocket feed
static/
  index.html, style.css, app.js    the dashboard (no build step, plain JS)
```

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Open `http://localhost:8000`.

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Railway auto-detects Python via Nixpacks and uses `railway.json` /
   `Procfile` for the start command (`uvicorn app.main:app --host 0.0.0.0
   --port $PORT`). No environment variables are required to run in paper
   mode.
4. Once deployed, open the Railway-provided URL — the dashboard is served
   at `/`, live data over `/ws`, and a JSON snapshot at `/api/snapshot`.

## Notes / known simplifications

- Fill simulation assumes your resting order fills in full the instant
  the ask touches your price — real order books can partial-fill or you
  can be queued behind other resting orders at the same price.
- Settlement uses Polymarket's live CLOB price at T‑2s as a proxy for the
  window's outcome, per your spec — this is not the same as Polymarket's
  own on-chain resolution, which may differ in edge cases.
- $5,000 per rung is tracked as a running paper balance, not a hard order
  cap — orders are always sized in shares per your ladder, regardless of
  the balance (flag this if you want a hard capital guard added).
