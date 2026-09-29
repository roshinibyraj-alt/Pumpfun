# Polymarket Copy-Trading Demo Bot

Mirrors a chosen Polymarket wallet's trades at a fixed ratio, in a
**paper account only** — no private key, no CLOB API key, no real order is
ever signed or sent. It exists to answer one question concretely: *how much
capital would you actually need to copy this wallet?*

Default master wallet: `0x2005d16a84ceefa912d4e380cd32e7ff827875ea`
(override with the `MASTER_WALLET` env var). Default copy ratio: **10%**.
Default demo capital: **$10,000**.

## What it does

1. **Startup** — the bot deliberately does **not** copy whatever the
   master wallet already had open before it started. It fetches their
   recent trade history purely to mark it as "already seen," so none of
   it gets mistaken for a new signal.
2. **Live copying** — from that point on, it polls the master's trade
   feed (`/v2/trades`) every few seconds. Every new BUY or SELL placed by
   the master **after the bot started** is copied at 10% of the shares
   traded, in the same market and outcome. Trades that predate the bot's
   startup are never copied, even if the resulting position is still open.
3. **Two ledgers, side by side:**
   - **Demo ledger** (capped): the actual $10,000 paper account. If a
     copy signal costs more than the remaining cash, it's filled as far
     as the cash allows (`PARTIAL_FILL`) or skipped entirely if cash is
     already at zero (`SKIPPED`) — both are logged and shown in the feed.
   - **Capital-required ledger** (uncapped): tracks what 10%-of-master
     would have cost with **no** spending limit, and its peak over time.
     This is the dashboard's hero number — the real answer to "how much
     capital do I need to run this strategy without ever being
     cash-constrained."
4. **Dashboard**: a hero gauge comparing the $10,000 demo capital against
   the peak capital actually required, max/min/avg cost per copied trade,
   live open positions marked to market (floating P&L), and a full feed
   of every copy action taken.

## Known limitations (read before relying on this)

- **Field-name assumptions**: this build could not be tested against a
  live call to `data-api.polymarket.com` (no network access in the build
  sandbox). Parsing in `app/data_client.py` is defensive — it tries
  several likely field-name spellings per value — but if Polymarket's
  actual v2 response differs, some fields may come back empty. Check the
  **Engine Log** panel after deploying; parsing failures are logged
  clearly (e.g. "no price available"), so a mismatch is easy to spot and
  patch.
- **Trade-feed ordering**: `/v2/trades` is assumed newest-first with no
  explicit `sort_direction` needed; the bot re-sorts by timestamp and
  dedupes by a composite key regardless, so a different default order
  from the API would not cause replays, just a one-tick delay in seeing
  the first batch.
- **Sell sizing**: a SELL is copied as 10% of the shares the master sold,
  capped at whatever we currently hold in that token (never a negative
  position). Because pre-existing positions are never copied, if the
  master sells shares from a position they opened *before* the bot
  started, we hold nothing in that token and the sell is simply skipped
  (logged, not an error) — there's nothing for us to sell. Only positions
  the master opens *after* the bot starts are tracked share-for-share.
- This is **not** connected to a real wallet or the CLOB trading API —
  it cannot place, cancel, or ever touch a real order.

## Project layout

```
app/
  config.py         master wallet, copy ratio, demo capital, timing
  models.py          CopiedPosition / CopyTradeRecord
  data_client.py      Polymarket Data API + CLOB price client (no auth)
  engine.py            startup, live copy loop, dual capital ledgers
  main.py               FastAPI app, REST snapshot, websocket feed
static/
  index.html, style.css, app.js    the dashboard (no build step)
```

## Run locally

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
Open `http://localhost:8000`.

## Deploy on Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Nixpacks auto-detects Python; `railway.json`/`Procfile` set the start
   command. No environment variables required unless you want to copy a
   different wallet (`MASTER_WALLET`) or change the ratio/capital in
   `app/config.py`.
