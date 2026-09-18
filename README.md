# Two-zone momentum ladder — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. UP and
DOWN each run their own fully independent momentum ladder across two
zones. This version buys strength instead of buying dips.

## Strategy

**Zone A (0.60 → 0.90)** — placed all at once, immediately, the
instant the window opens. Each entry fills when that side's ask rises
through the rung:
- 0.60 → 50 shares
- 0.70 → 100 shares
- 0.80 → 200 shares
- 0.90 → 400 shares

**Zone B (confirmation entries)** — activated 2 minutes after window
open. Each entry is placed once after its independent strength trigger:
- price reaches 0.60 → place momentum entry @ 0.70, 100 shares
- price reaches 0.70 → place momentum entry @ 0.80, 200 shares
- price reaches 0.80 → place momentum entry @ 0.90, 400 shares

Both zones are always live together — nothing about one disables the
other. The entry condition is deliberately reversed from the former
dip-buy ladder: `ask >= entry_price`, not `ask <= entry_price`.

**Exit** — when the side reaches 0.99, redeem all held shares at
$1.00/share. **There is no stop-loss anywhere in this design.**

If the sell fills, that side goes flat, but any still-resting
(unfilled) buy rungs stay live — a later fill can start a fresh
accumulation / sell-requote cycle within the same window.

**Window close** — cancel any still-resting buy/sell orders (no
penalty) and force a taker close (real fee, real depth-weighted price)
on any shares still held.

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `ZONE_A_RUNGS`, `ZONE_B_RUNGS`, `ZONE_B_DELAY_SECONDS`
- `STARTING_CAPITAL` ($2000, single shared pool for both sides)
- Taker fee constants (momentum entries are simulated at their entry
  price; only a forced window-end close pays the real taker fee)

## Notes / assumptions

- All momentum entries are simulated as filling fully at their exact
  entry price, with no fee or slippage. The depth-aware realistic
  fill-price logic only applies to the forced taker close at window end.
- Zone B triggers are checked against that side's own **mid** price,
  independently each tick — reaching 0.80 does not require 0.60 or
  0.70 to have triggered first; all three can fire in the same tick if
  price jumps far enough.
- A side's still-resting (never-filled) momentum entries remain live for
  the rest of the window — a later rally can fill them.
- Every entry fill debits the capital balance immediately (verified
  explicitly in testing — this is the exact bug class that showed up
  in an earlier version of this bot, where fills updated share/cost
  tracking without moving real balance).
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` and `state.py`/`main.py`'s orchestration loop
  are unchanged from the previous version.
