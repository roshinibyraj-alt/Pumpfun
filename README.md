# Polymarket 15-Minute Cross-Market Bot (Paper / Demo Mode)

Trades a cross-asset divergence strategy across Polymarket's 15-minute
BTC and ETH Up/Down markets. **This bot is paper-trading only** — it reads
Polymarket's real, public order books but never signs or submits a real
order. All fills, fees, and P&L are simulated against a virtual $2,000
bankroll (configurable).

## Strategy

Each 15-minute window has two independent binary markets: `BTC Up/Down`
and `ETH Up/Down`. The bot watches two synthetic pairs:

- **Pair A**: BTC-Up + ETH-Down
- **Pair B**: BTC-Down + ETH-Up

Rules, per window:

1. **Entry** — either pair can fire (buy both legs) when its own combined
   ask price (best-ask-BTC-leg + best-ask-ETH-leg) drops below
   `ENTRY_COMBINED_PRICE` (default `0.85`). Each pair fires **at most once
   per window**.
2. **Take-profit is dynamic, decided by trigger order, not by which pair
   it is:**
   - Whichever pair fires **first** in the window gets an intra-window
     take-profit: if its combined bid rises to `EXIT_COMBINED_PRICE`
     (default `1.15`) or above, both legs are sold immediately, profit is
     realized, and that pair is then **locked for the rest of the
     window** — no re-entry, even if it dips below 0.85 again.
   - Whichever pair fires **second** (or is the only one that fires that
     window) gets **no take-profit at all** — once bought, it is simply
     held to resolution.
3. **Resolution — CLOB price only, no Gamma fallback.** For any position
   still open when its window closes (the no-TP pair always; the
   first-fired pair only if TP never triggered), the bot resolves it
   using **only** the live CLOB order book: once the window has ended,
   each leg the position actually holds is re-priced from its own token's
   book (last trade price, or best bid if no trade yet). A leg is a
   confirmed **winner ($1/share)** at price ≥ `RESOLUTION_PRICE_THRESHOLD`
   (default `0.90`), or a confirmed **loser ($0/share)** at price ≤ `1 -
   RESOLUTION_PRICE_THRESHOLD` (`0.10`). If either leg's price is still
   ambiguous, the bot keeps polling every `RESOLUTION_POLL_SECONDS`
   instead of guessing — there is no Gamma `outcomePrices`/`closed` check
   and no other fallback path.
4. Next window, the first-fired/TP-lock state resets and it's
   first-trigger-wins-TP again.

### Sizing: base 10, decorrelation boosts to 300

- Every window starts at `BASE_SHARES_PER_LEG` (default **10** shares per
  leg).
- **Decorrelation** = a resolved position where **both legs lost** (total
  payout $0) — i.e. the actual BTC/ETH outcome was the exact opposite
  combo of the pair that was bought (bet BTC-Up+ETH-Down, but BTC
  actually went Down and ETH actually went Up, or vice versa). A
  take-profit close never counts — that's a win by definition; only an
  actual resolution can decorrelate.
- The moment any resolved position shows a full double-loss, the boost is
  armed: the **next window whose entries haven't fired yet** uses
  `BOOSTED_SHARES_PER_LEG` (default **300**) instead of base, for
  whichever pair(s) fire in that window.
- The window after the boosted one always reverts to base (`10`),
  regardless of whether the boosted window won, partially lost, or
  decorrelated again (which would just re-arm the boost for one more
  window — it doesn't compound beyond that).
- Because Polymarket's/the CLOB's resolution price can take a little
  while to become unambiguous after a window ends, the boost sometimes
  lands on the window after next rather than literally the next one on
  the clock — it always targets whichever window hasn't fired entries
  yet at the moment the decorrelation is confirmed.

The live dashboard shows the current window's shares/leg and whether the
boost is armed for the next window.

## Fees

Confirmed against Polymarket's own docs and a live market's fee schedule:
crypto-category 15-minute markets charge a **taker-only** dynamic fee —
makers pay $0.

```
fee_usd = shares * fee_rate * price * (1 - price)
```

`fee_rate` is read live per-market from Gamma's `feeSchedule.rate` field
(observed at `0.07` for BTC/ETH 15-min markets, i.e. up to 1.75% of
notional at a $0.50 price, shrinking toward the extremes). This bot is
taker-only by design — every entry and exit crosses the spread — so this
fee is applied to every simulated fill.

## Execution model

- **Taker only**, capped by a slippage ceiling on buys (`0.99`, i.e. never
  pay more than that per share) and a slippage floor on Pair A's sells
  (`0.01`, i.e. never accept less), so orders effectively always fill.
- Fills are simulated by walking the **real live order book** (not just
  top-of-book), so partial fills / slippage on thin books show up
  honestly in the fill price, and are logged if a leg can't be fully
  filled inside the cap.
- A few polling ticks after every fill, the bot re-checks the book on
  those same tokens and logs a snapshot (`post_fill_check` in `/status`)
  so you can see how much the market moved right after you traded.

## Running locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit if you want different thresholds
python main.py
```

Then open `http://localhost:8080` for the dashboard, or `GET /status` for
raw JSON.

## Deploying on Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway will detect the `Dockerfile` automatically.
3. Set any env vars you want to override (see `.env.example`) in the
   Railway **Variables** tab. None are required — sensible defaults ship
   in `app/config.py`.
4. **Attach a Volume mounted at `/data`** if you want balance/trade
   history to survive redeploys — otherwise `bot_state.db` is stored on
   the container's ephemeral disk and resets on every redeploy.
5. Deploy. Railway will expose a public URL serving the dashboard on the
   port Railway assigns (`$PORT`, already wired up in `app/config.py`).

## Project layout

```
app/
  config.py     # all thresholds/env vars in one place
  gamma.py      # Gamma API market discovery (slug -> conditionId/tokenIds/fees)
  clobbook.py   # public CLOB order book fetch (no auth needed, read-only)
  fills.py      # simulated taker fill against real book depth
  fees.py       # Polymarket's dynamic crypto taker-fee formula
  pairs.py      # combines two legs into a tradeable "combined price"
  engine.py     # paper bankroll, open positions, realized/unrealized P&L
  strategy.py   # the main loop: discovery -> pricing -> entries/exits -> resolution
  storage.py    # SQLite persistence (balance + trade history)
  server.py     # FastAPI dashboard + /status JSON + /health
main.py         # runs the bot loop and the web server together
```

## Going from paper to real trading (not included)

This build intentionally stops short of real order signing, since that
requires your funded Polygon wallet, CLOB API credentials, and USDC/CTF
allowances — all real-money infrastructure you should set up and review
yourself. If/when you want that:

- Swap `fills.py`'s simulated walk for real order submission via
  `py-clob-client` (`createAndPostOrder`, `OrderType.FOK`/`FAK` for
  taker-guaranteed fills).
- Add wallet funding checks, USDC/CTF allowance approval, and an on-chain
  redemption step for resolved positions (claiming the $1/share payout is
  a separate transaction from the trade itself).
- Add a kill switch / max-daily-loss check before flipping live — this
  repo has no real risk controls beyond the pair-level re-entry rule,
  since it was built for paper trading first.

## Disclaimer

This is trading-adjacent software provided for experimentation. Nothing
here is financial advice. Prediction markets carry real risk of loss;
past paper performance says nothing about live performance, where
latency, real slippage, and execution risk all bite harder than a
simulation.
