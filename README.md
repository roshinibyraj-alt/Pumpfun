# Two-zone ladder, dynamic re-quoted sell — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. UP and
DOWN each run their own fully independent ladder of resting limit buys
across two zones, with a single limit sell that re-quotes to
`avg_entry + 0.10` after every fill.

## Strategy

**Zone A (0.40 → 0.10)** — placed all at once, immediately, the
instant the window opens:
- 0.40 → 50 shares
- 0.30 → 100 shares
- 0.20 → 200 shares
- 0.10 → 400 shares

**Zone B (0.60 → 0.90)** — each rung placed once, only after its own
trigger is first reached (checked independently every tick):
- price reaches 0.70 → place resting buy @ 0.60, 100 shares
- price reaches 0.80 → place resting buy @ 0.70, 200 shares
- price reaches 0.90 → place resting buy @ 0.80, 400 shares

Both zones are always live together — nothing about one disables the
other.

**Exit** — the instant ANY rung fills (zone A or B), recompute the
average entry price across every share held on that side, cancel the
currently-resting sell (if any), and place a fresh resting limit sell
at `avg_entry + 0.10` for the full held size. A later fill can move
this either direction: a Zone A fill (lower price) pulls the average
(and the sell quote) down; a Zone B fill (higher price) pulls it up.
**There is no stop-loss anywhere in this design.**

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

- `ZONE_A_RUNGS`, `ZONE_B_RUNGS`, `SELL_OFFSET`, `SELL_PRICE_CAP`
- `STARTING_CAPITAL` ($2000, single shared pool for both sides)
- Taker fee constants (buy rungs and the sell are fee-free maker fills; only a forced window-end close pays the real taker fee)

## Notes / assumptions

- All buy rungs and the dynamic sell are simulated as filling fully, at
  their exact limit price, no fee, no slippage — the depth-aware
  realistic-fill-price logic only applies to the forced taker close at
  window end.
- Zone B triggers are checked against that side's own **mid** price,
  independently each tick — reaching 0.90 does not require 0.70 or
  0.80 to have triggered first; all three can fire in the same tick if
  price jumps far enough.
- The sell price is capped at `SELL_PRICE_CAP` (0.99) regardless of
  avg entry, so it's never quoted at an untradeable price ≥ 1.00.
- After a full sell-out, a side's still-resting (never-filled) buy
  rungs remain live for the rest of the window — a later dip or rally
  can refill them and start a new accumulation/sell cycle.
- Every buy-rung fill debits the capital balance immediately (verified
  explicitly in testing — this is the exact bug class that showed up
  in an earlier version of this bot, where fills updated share/cost
  tracking without moving real balance).
- This reuses `models.py` and `paper_broker.py` unchanged;
  `polymarket_client.py` and `state.py`/`main.py`'s orchestration loop
  are unchanged from the previous version.
