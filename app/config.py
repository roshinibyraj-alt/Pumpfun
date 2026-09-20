"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- BTC-spot-trend entry (buys the direction BTC itself
has been trending in, not anything about the previous window or the
token's own cheapness), continuous trailing stop (tightens above a
price threshold, and inactive for a delay after window open), a hard
stop-loss override once deep ITM, single trade per window, TP
redemption:

  1. BTC trend signal (independent of the Polymarket window clock):
     BTC spot price is polled roughly every BTC_FETCH_INTERVAL_SECONDS
     (~3s) from an external price feed (see fetch_btc_spot_price() in
     polymarket_client.py) and bucketed into BTC_BLOCK_SECONDS (30s)
     blocks, each block's value being the average of its samples. The
     last BTC_TREND_HISTORY_BLOCKS (20) completed blocks are kept.
     Every time a block completes, the trend is recomputed by looking
     at the most recent BTC_TREND_LOOKBACK_BLOCKS (5) of them: if
     they're strictly increasing block-over-block, the trend is UP; if
     strictly decreasing, the trend is DOWN; anything else (flat,
     mixed, a reversal partway through) is NO TREND. This runs
     continuously across window boundaries -- it doesn't reset when a
     new Polymarket window opens.
  2. Entry: from window open, wait ENTRY_SETTLE_SECONDS (a couple of
     seconds -- just long enough for the first tick's order-book data
     to exist, not a strategic delay). At that single check:
       - if there's no clear BTC trend right now, the window is
         skipped outright -- nothing to follow.
       - if the trend is UP, the target side is UP; if DOWN, the
         target side is DOWN.
       - if that side's price is BELOW ENTRY_PRICE_THRESHOLD (0.40),
         buy it immediately, flat BASE_ORDER_SHARES.
       - if it's at or above 0.40, no trade is taken this window --
         this is a single check, not a rearmed watch.
  3. Trailing stop: continuous, not stepped, and inactive until
     TRAIL_START_DELAY_SECONDS (180s / 3min) after the WINDOW OPENED --
     not after entry. Before it's armed, only TP can close the
     position (the high-water mark still tracks the whole time, so the
     stop starts from wherever price has gotten to once it activates,
     not from scratch). Once active, every tick that the position's
     mid has made a new high-water mark, the stop is recomputed as
     high_water_mark - trail_distance, rounded to the cent (0.01) tick
     size. The trail distance is TRAIL_DISTANCE (0.20) normally, but
     narrows to TRAIL_DISTANCE_TIGHT (0.10) once the high-water mark
     has gone above TRAIL_TIGHTEN_PRICE (0.85) -- tightening the stop
     as the position gets deep in the money. It only ever moves up
     (one-way ratchet) since it's driven off the monotonic high-water
     mark. Mid <= stop -> stop hit (once active).
  3a. Hard stop override: independent of the arming delay above, the
     instant the position's high-water mark reaches HARD_STOP_TRIGGER_PRICE
     (0.90), the trailing stop is permanently deactivated for the rest
     of that position and replaced with a fixed HARD_STOP_PRICE (0.60)
     stop-loss -- much wider than where the tightened trail would sit
     (e.g. a 0.95 high-water mark would trail-stop at 0.85, but once
     the hard stop takes over it's 0.60 instead), deliberately giving
     the position room to wobble near resolution instead of getting
     stopped out by a small pullback. This does not revert even if
     price pulls back below 0.90 afterwards.
  4. TP: TP_PRICE (0.99) hit -> REDEEMED, not sold -- credited at a
     flat $1.00/share, zero fee (CTF resolution redemption).
  5. No flips: a stop-hit closes the position and the window is done --
     at most one trade per window, no re-entry on the opposite side.
  6. Sizing: flat, no martingale of any kind. Every entry is exactly
     BASE_ORDER_SHARES. No cross-window sizing memory either; every
     window starts fresh.
  7. Window close: if a position is still open when the window closes,
     it's force-closed at whatever the market will pay (real taker
     sell).

At most one position open at a time, one trade per window, no order-book
ladder, no merge.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / pricing ---------------------------------------
# CLOB only -- no Gamma price fallback anywhere in this app. Gamma is
# used purely for one-time window metadata (slug -> token ids) in
# polymarket_client.py; every live price/book read goes to CLOB.
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "0.5"))

# ---- BTC spot price feed / trend tracking -----------------------------
# Public, no-auth spot price endpoint. Independent of Polymarket's own
# CLOB/Gamma APIs above -- this is the actual BTC/USD spot price, used
# purely to detect a short-term trend, not for anything Polymarket-
# specific.
BTC_SPOT_API_URL = os.getenv("BTC_SPOT_API_URL", "https://api.coinbase.com/v2/prices/BTC-USD/spot")
BTC_FETCH_INTERVAL_SECONDS = 3.0   # how often to poll BTC spot price -- deliberately much slower than
                                    # the 0.5s Polymarket book-polling tick so we don't hammer a public API
BTC_BLOCK_SECONDS = 30.0           # length of one BTC trend block (average of samples within it)
BTC_TREND_HISTORY_BLOCKS = 20      # rolling window of completed blocks kept (20 * 30s = 10 minutes)
BTC_TREND_LOOKBACK_BLOCKS = 5      # how many of the most recent completed blocks must be strictly
                                    # monotonic (all up, or all down) for a trend signal to fire

# ---- BTC-trend entry / continuous trailing stop engine -----------------
ENTRY_SETTLE_SECONDS = 2.0        # brief technical delay after window open before the single entry
                                   # check -- just long enough for the first tick's book data to exist,
                                   # not a strategic wait
ENTRY_PRICE_THRESHOLD = 0.40      # the BTC-trend side must be strictly below this to buy; a single
                                   # check, not a rearmed watch -- if it's not below 0.40 at that
                                   # moment, no trade is taken this window
TP_PRICE = 0.99                   # take-profit level -- hit = redeemed at $1.00, fee-free
TRAIL_DISTANCE = 0.20             # continuous trailing stop distance from high-water mark
TRAIL_DISTANCE_TIGHT = 0.10       # narrowed trail distance once high-water mark > TRAIL_TIGHTEN_PRICE
TRAIL_TIGHTEN_PRICE = 0.85        # high-water mark threshold above which the tighter trail applies
TRAIL_START_DELAY_SECONDS = 180.0 # trailing stop is inactive until this long after WINDOW OPEN (not entry) -- TP still live
HARD_STOP_TRIGGER_PRICE = 0.90    # high-water mark threshold that permanently swaps trailing for the hard stop
HARD_STOP_PRICE = 0.60            # fixed stop-loss price once the hard stop is triggered -- no longer trails
PRICE_TICK = 0.01                 # rounding granularity for the stop price

BASE_ORDER_SHARES = 100.0         # flat size for every entry -- initial and every flip, no martingale

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every sell settlement. Halts
# permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Entry, SL, and a forced window-end close are reactive/triggered fills
# (not resting orders placed ahead of time), so all three are modeled
# as TAKER fills and pay the fee for real, priced by walking real book
# depth. TP is the one exception: it's booked as a resolution
# redemption (see TP_PRICE above), not an orderbook trade, so it pays
# no fee at all. Verify the taker rate against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
