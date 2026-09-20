# BTC-trend entry, TP only, no stop-loss — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: continuously track real BTC spot price in rolling
30-second blocks, and when the last 5 blocks are cleanly trending one
way, buy that direction shortly after the next window opens — if it's
still cheap enough. From there, the position only exits at take-profit
or when the window ends — there is no stop-loss of any kind. At most
one trade per window — no re-entry.

## Strategy

1. **BTC trend signal** (`app/btc_trend.py`, `BtcTrendTracker`) — runs
   continuously, independent of the Polymarket window clock:
   - BTC/USD spot price is polled roughly every
     `BTC_FETCH_INTERVAL_SECONDS` (3s) from a public, no-auth price
     feed (`fetch_btc_spot_price()` in `app/polymarket_client.py`,
     currently Coinbase's spot endpoint).
   - Samples are bucketed into `BTC_BLOCK_SECONDS` (30s) wall-clock
     blocks; each block's value is the average of the samples that
     landed in it.
   - The last `BTC_TREND_HISTORY_BLOCKS` (20, i.e. 10 minutes) of
     completed blocks are kept in a rolling window.
   - The trend is read off the most recent `BTC_TREND_LOOKBACK_BLOCKS`
     (5) completed blocks: **strictly increasing** block-over-block →
     `up`; **strictly decreasing** → `down`; anything else (flat,
     mixed, a reversal partway through, or not enough history yet) →
     no trend.
2. **Entry**: wait `ENTRY_SETTLE_SECONDS` (2s) after the window opens
   — just long enough for the first tick's order-book data to exist,
   not a strategic delay — then make a **single** check:
   - if there's no clear BTC trend right now, the window is skipped
     entirely.
   - an **uptrend** targets **UP**; a **downtrend** targets **DOWN**.
   - if the target side's price is **below `ENTRY_PRICE_THRESHOLD`
     (0.40)** at that moment, buy it immediately, flat
     `BASE_ORDER_SHARES`.
   - if it's at or above 0.40, **no trade is taken this window** —
     this is a single check, not a rearmed watch; the bot doesn't keep
     waiting for the price to come down.
3. **Exit — TP only, no stop-loss**: once filled, every tick checks
   that side's mid against the take-profit level. That's the only exit
   trigger:
   - **Take-profit (0.99)**: treated as a certain win and
     **redeemed**, not sold — credited at a flat **$1.00/share,
     fee-free** (a CTF resolution redemption, not an orderbook trade),
     instead of taker-selling at ~0.99 and losing a sliver of edge to
     fee/slippage.
   - **There is no stop-loss** — trailing, fixed, or otherwise. A
     position that goes deep underwater is simply held; it doesn't get
     cut, all the way down to zero if that's where the token ends up.

   The only other way out is the **window closing** before TP is hit:
   the position is force-closed at whatever the market will pay (a
   real taker sell). That's it — two exits total, TP or the forced
   close.
4. **Sizing**: flat. Every entry is exactly `BASE_ORDER_SHARES`
   (100), no martingale, no cross-window sizing memory — every window
   starts fresh.

At most one trade is open per window, on one side only — a position
never exists on both sides simultaneously, so there's no fee-free CTF
merge mechanic here (that only applies when holding both complementary
outcome tokens at once).

## Run locally

```
pip install -r requirements.txt
cp .env.example .env   # edit if needed
uvicorn app.main:app --reload
```

Dashboard at http://localhost:8000

## Config knobs (`app/config.py`)

- `BTC_SPOT_API_URL` — public BTC/USD spot price feed (Coinbase by default)
- `BTC_FETCH_INTERVAL_SECONDS` (3) — how often BTC spot is polled, independent of the 0.5s Polymarket tick
- `BTC_BLOCK_SECONDS` (30), `BTC_TREND_HISTORY_BLOCKS` (20), `BTC_TREND_LOOKBACK_BLOCKS` (5) — trend-block sizing
- `ENTRY_SETTLE_SECONDS` (2) — technical delay after window open before the single entry check
- `ENTRY_PRICE_THRESHOLD` (0.40) — trend side must be strictly below this to buy
- `TP_PRICE` (0.99) — the only take-profit/stop-loss config in the bot; there is no stop-loss knob because there is no stop-loss
- `BASE_ORDER_SHARES` (100) — flat size, no martingale
- `STARTING_CAPITAL`, taker fee constants (entry and forced-close are taker fills; TP is a fee-free redemption at $1.00, not a trade)

## Notes / assumptions

- The BTC trend tracker is entirely separate from the Polymarket
  window clock — it keeps accumulating blocks across window
  boundaries, so a trend that started forming several windows ago can
  still be "current" when a new window opens.
- "Strictly monotonic" is a deliberately clean definition: a single
  flat or reversing block anywhere in the lookback window kills the
  signal for that check. This trades off some missed trends for fewer
  false positives; loosening it (e.g. requiring only the endpoints to
  differ) is a one-line change in `BtcTrendTracker.trend()` if a
  noisier signal is preferred.
- A gap in BTC price polling (feed downtime, a slow response) doesn't
  fabricate missing blocks — that period is just silently skipped, and
  the next block starts fresh from whenever polling resumes.
- The entry check is a **single** evaluation, not a rearmed watch: if
  the trend side isn't below 0.40 at the `ENTRY_SETTLE_SECONDS` mark,
  that's it for the window — the bot doesn't keep checking as the
  window progresses.
- TP being modeled as a flat $1.00 redemption assumes a token sitting
  at 0.99 is a settled win — it does not model the (small) chance the
  window still resolves against it before the redemption actually
  happens on-chain.
- There is no stop-loss anywhere in this bot, trailing or fixed. A
  filled position has exactly two exits: TP, or the window closing
  first and forcing a taker close at whatever the market will pay. If
  price collapses to near zero and never recovers before the window
  ends, the position rides it all the way down and is force-closed
  near $0 — this is a deliberate simplification, not a bug, per the
  "TP at 0.99, that's it" instruction this version implements.
- A stop-out concept no longer exists, so there's nothing terminal to
  trigger mid-window besides TP itself. At most one trade is taken per
  window either way, since there's still no flip/re-entry.
- Both the entry and the forced-close exit are modeled as **taker**
  fills, priced by walking real order-book depth rather than assuming
  unlimited size at the top-of-book quote.
- The cost of every fill is debited from the capital balance the
  instant it fills, and every exit's proceeds are credited back —
  `starting_capital + total_pnl` should match the final balance
  exactly across any sequence of trades.
- If the book is fetched successfully but truly has nothing resting on
  the held side at exit time (`bids: []`), that's treated as a real
  no-liquidity signal — the position is marked down to $0 rather than
  assuming no loss. If the book fetch itself fails (`None`, not `[]`),
  that's a genuine data gap and the last known price is used instead.
- A window is counted as a no-trade window whenever it ends without a
  fill: no clear BTC trend at the entry check, or the trend side was
  at/above the 0.40 threshold at that moment.
- The Polymarket window's own winner is no longer used by the entry
  logic at all (this replaced an earlier momentum-continuation
  strategy). `_infer_winner()` in `app/state.py` is still called at
  rollover purely to log a `SETTLED_BY_PRICE` line for the dashboard
  audit trail — it's informational only now.
- This reuses `models.py` unchanged; `polymarket_client.py` gained one
  new method (`fetch_btc_spot_price()`) alongside its existing
  Polymarket-specific methods (full order-book depth via
  `get_book_full()`), and `state.py`'s orchestration loop gained the
  BTC-polling/trend-tracking wiring but is otherwise unchanged.
