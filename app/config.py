"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- BTC-spot-trend entry (buys the direction BTC itself
has been trending in, not anything about the previous window or the
token's own cheapness), single trade per window, TP redemption, no
stop-loss of any kind:

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
  3. Exit: TP_PRICE (0.99) hit -> REDEEMED, not sold -- credited at a
     flat $1.00/share, zero fee (CTF resolution redemption). There is
     no stop-loss, trailing or otherwise: once filled, a position only
     ever exits via TP or via the forced close below. It rides out
     every other price move for the rest of the window, including all
     the way to zero.
  4. No flips: once a position closes (TP or forced), the window is
     done -- at most one trade per window, no re-entry on the opposite
     side.
  5. Sizing: flat, no martingale of any kind. Every entry is exactly
     BASE_ORDER_SHARES. No cross-window sizing memory either; every
     window starts fresh.
  6. Window close: if a position is still open when the window closes
     without having hit TP, it's force-closed at whatever the market
     will pay (real taker sell) -- this is the only other way out of a
     position besides TP.

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
                                   # -- no stop-loss config: this bot no longer has one, TP and the
                                   # forced window-end close are the only two ways out of a position

BASE_ORDER_SHARES = 100.0         # flat size for every entry -- initial and every flip, no martingale

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every sell settlement. Halts
# permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Entry and a forced window-end close are reactive/triggered fills
# (not resting orders placed ahead of time), so both are modeled
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
