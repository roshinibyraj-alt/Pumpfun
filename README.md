# BTC-trend entry, tightening trail, single trade — BTC 5m bot

Paper-trading bot for Polymarket's `btc-updown-5m-*` markets. Runs a
single strategy: continuously track real BTC spot price in rolling
30-second blocks, and when the last 5 blocks are cleanly trending one
way, buy that direction shortly after the next window opens — if it's
still cheap enough. Then manage the exit with a continuous trailing
stop that arms after a delay and tightens once the position gets deep
in the money, with a wide fixed hard stop taking over once the
position is deep ITM. At most one trade per window — no re-entry after
a stop-out.

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
3. **Exit**: once filled, every tick checks that side's mid against a
   take-profit level, a trailing stop, and a hard-stop override.
   - **Take-profit (0.99)**: live immediately from entry, treated as a
     certain win and **redeemed**, not sold — credited at a flat
     **$1.00/share, fee-free** (a CTF resolution redemption, not an
     orderbook trade), instead of taker-selling at ~0.99 and losing a
     sliver of edge to fee/slippage.
   - **Trailing stop**: inactive until **3 minutes after the window
     opened** (`TRAIL_START_DELAY_SECONDS`, not 3 minutes after
     entry). Before it arms, only TP can close the position; the
     high-water mark keeps tracking the whole time regardless, so once
     it arms it starts from wherever price has already gotten to, not
     from scratch. Once armed, recomputed every tick as
     `high_water_mark − trail_distance`, rounded to the cent. It only
     ever moves up, since it's driven off the position's monotonic
     high-water mark (best mid seen since entry), never the raw
     current price:
     - trail distance is **0.20** while the high-water mark is at or
       below 0.85
     - once the high-water mark climbs **above 0.85**, the trail
       narrows to **0.10** — tightening the stop as the position gets
       deep in the money
   - **Hard-stop override**: independent of the 3-minute trailing-arm
     delay above, the instant the position's high-water mark reaches
     **0.90**, the trailing stop is **permanently deactivated** for
     that position and replaced with a **fixed stop-loss at 0.60** —
     much wider than where the tightened trail would sit (e.g. a 0.95
     high-water mark would trail-stop at 0.85, but once the hard stop
     takes over it's 0.60 instead). This deliberately gives a
     deep-in-the-money position room to wobble near resolution instead
     of getting stopped out by a routine pullback, and it does **not**
     revert even if price later falls back under 0.90.

     A stop exit (trailing or hard) is a real taker sell, priced by
     walking real bid depth — unlike TP, it isn't a guaranteed-
     resolution redemption.
   - **A stop-out ends the window.** There's no flip into the opposite
     side and no re-entry — at most one trade per window.

   If the window closes before either TP or a stop is reached, the
   position is force-closed at whatever the market will pay (also a
   real taker sell).
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
- `TP_PRICE` (0.99)
- `TRAIL_START_DELAY_SECONDS` (180) — trailing stop is inactive until this long after **window open** (not entry); TP is live the whole time
- `TRAIL_DISTANCE` (0.20), `TRAIL_DISTANCE_TIGHT` (0.10), `TRAIL_TIGHTEN_PRICE` (0.85) — trail
  narrows from 0.20 to 0.10 once the position's high-water mark climbs above 0.85
- `HARD_STOP_TRIGGER_PRICE` (0.90), `HARD_STOP_PRICE` (0.60) — once the high-water mark reaches
  the trigger, trailing is permanently replaced by this fixed stop, independent of the arm delay
- `BASE_ORDER_SHARES` (100) — flat size, no martingale
- `STARTING_CAPITAL`, taker fee constants (entry, stop, and forced-close are taker fills; TP is a fee-free redemption at $1.00, not a trade)

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
- The trailing stop only ever moves up. It's driven by the position's
  high-water mark, not the current price, so a spike to 0.90 followed
  by a pullback to 0.85 does **not** trigger a stop by itself — only a
  further drop through the (possibly now-tightened) stop level would.
- During the first 3 minutes **after the window opens**, the trailing
  stop cannot fire at all, even if price craters — only TP is live.
  The high-water mark still updates during that window, so if price
  runs up and pulls back before the delay is over, the stop (once
  armed) reflects the peak it already saw, not the price at the
  moment of arming.
- The hard-stop override is a separate mechanism from the trailing-arm
  delay above and isn't gated by it: it can trigger in the first few
  seconds of a position if price runs to 0.90 fast enough. Once it
  triggers, the position no longer benefits from the tightened trail
  at all for the rest of the window — it's protected only by the fixed
  0.60 floor.
- A stop-out is terminal for the window: no flip into the opposite
  side, no re-entry. At most one trade is taken per window.
- Both the entry and the exit are modeled as **taker** fills, priced
  by walking real order-book depth rather than assuming unlimited size
  at the top-of-book quote.
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
