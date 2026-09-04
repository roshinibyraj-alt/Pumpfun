# Polymarket 5-Minute Cross-Market Bot (Paper / Demo Mode)

Trades a cross-asset divergence strategy across Polymarket's 5-minute
BTC and ETH Up/Down markets. **This bot is paper-trading only** — it reads
Polymarket's real, public order books but never signs or submits a real
order. All fills, fees, and P&L are simulated against a virtual $2,000
bankroll (configurable).

## Strategy

Each 5-minute window has two independent binary markets: `BTC Up/Down`
and `ETH Up/Down`. The bot watches two synthetic pairs:

- **Pair A**: BTC-Up + ETH-Down
- **Pair B**: BTC-Down + ETH-Up

Rules, per window:

1. **Entry (at most once per window, across BOTH pairs)** — whichever
   pair's combined ask price (best-ask-BTC-leg + best-ask-ETH-leg) first
   drops below `ENTRY_COMBINED_PRICE` (default `0.85`) fires first: buy
   `SHARES_PER_LEG` (default `300`) shares of *both* legs. The instant
   one pair fires, the other pair is **locked out for the rest of that
   window** — no re-entry, no second combo, even if its own combined ask
   also dips below the threshold.
2. **No intra-window take-profit.** There is no selling mid-window.
   Whatever fires is held to resolution, every time.
3. **Resolution** — once the market closes, Polymarket settles it based
   on the real BTC/ETH price vs. the window's opening strike (via its
   oracle price feed) — **not** by any CLOB price threshold. Each leg
   pays $1/share if its outcome won, $0/share if it lost.
4. Next window, both pairs are live again and it's first-trigger-wins
   once more.

### A correction worth knowing

Polymarket doesn't resolve these markets by "whichever side's CLOB price
is above $0.90 in the last two seconds" — that's just a *symptom* of the
book pricing in a near-certain outcome as the window closes. The actual
settlement compares the real spot price to the opening strike. This bot:

- Uses Polymarket's own resolution field (`outcomePrices` /
  `closed` on the Gamma event) as the source of truth once available.
- Uses the ">= 0.90 late in the window" idea only as a **fallback estimate**
  if Gamma hasn't flipped to `closed` yet by the time you check — clearly
  logged as an estimate, never as the authoritative settlement.

## Fees

Confirmed against Polymarket's own docs and a live market's fee schedule:
crypto-category 5-minute markets charge a **taker-only** dynamic fee —
makers pay $0.

```
fee_usd = shares * fee_rate * price * (1 - price)
```

`fee_rate` is read live per-market from Gamma's `feeSchedule.rate` field
(observed at `0.07` for BTC/ETH 5-min markets, i.e. up to 1.75% of
notional at a $0.50 price, shrinking toward the extremes). This bot is
taker-only by design — every entry and exit crosses the spread — so this
fee is applied to every simulated fill.

## Execution model

- **Taker only**, capped by a slippage ceiling on buys (`0.99`, i.e. never
  pay more than that per share), so the single entry per window
  effectively always fills.
- Fills are simulated by walking the **real live order book** (not just
  top-of-book), so partial fills / slippage on thin books show up
  honestly in the fill price, and are logged if a leg can't be fully
  filled inside the cap.
- A few polling ticks after the fill, the bot re-checks the book on
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
