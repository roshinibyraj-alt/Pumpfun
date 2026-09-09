"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Single engine: a price-level ladder on BOTH sides (UP and DOWN)
independently. Whenever the best ask or best bid on a side sits at a
price level not yet used this window, place a 10-share limit buy there
(ask = crosses the spread, fills immediately; bid = resting, fills
later if the market trades down to it). Each level trades at most once.
As UP and DOWN inventory both build up, matched pairs are immediately
merged -- Polymarket's real mechanic for redeeming one UP + one DOWN
share for a guaranteed $1, regardless of which side eventually wins.
Merge IS the exit; there is no separate take-profit price and no stop
loss. Any inventory left unmatched at window close settles at
resolution ($1/share if that side won, $0 if it lost).
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery ---------------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Engine (v12 -- dual-sided price-level ladder, merge-as-exit) --------
#
# Operating range: only price levels in [ENGINE_PRICE_MIN, ENGINE_PRICE_MAX]
# are tradeable. Levels are ENGINE_LEVEL_STEP apart (Polymarket's real
# tick size for these markets is $0.01).
ENGINE_PRICE_MIN = 0.10
ENGINE_PRICE_MAX = 0.95
ENGINE_LEVEL_STEP = 0.01

# Every fill -- ask-side or bid-side -- is this many shares. Fixed size,
# no martingale, no sizing based on any previous window's outcome.
ENGINE_ORDER_SHARES = 10.0

# Per side (UP, DOWN), per window: at most ONE entry per distinct price
# level. Once a level has been traded (or a resting order placed at it),
# it's marked used and never targeted again this window. Resets every
# window since each 5-min window is a brand-new market/token.
#
# Each tick, for each side:
#   - if the best ASK is at an unused level -> buy ENGINE_ORDER_SHARES
#     there. This crosses the spread, so it's a taker fill, immediate.
#   - if the best BID is at an unused level -> rest a buy order for
#     ENGINE_ORDER_SHARES there. This is a maker order; it only fills
#     later if the market's ask trades down to (or through) that price.
#
# Whenever both UP and DOWN inventory are simultaneously > 0, the
# matched quantity is merged/redeemed immediately for $1/pair -- that
# merge is the engine's only exit mechanism. There's no TP price and no
# SL; unmatched leftover inventory at window close rides to resolution.
MAKER_REBATE_FRACTION = 0.20   # rebate on the resting/bid-side fills only
# ask-side fills cross the spread (taker), so they pay the real taker
# fee computed below instead of earning a rebate.

# Demo capital: this is the number the dashboard's "Demo Capital" figure
# tracks. It starts here, moves with every fill and every merge/
# resolution settlement, and is the single source of truth for the
# bot's paper balance -- nothing else in the app tracks money
# separately. If it ever drops below $0 (can't cover the next fill),
# the engine halts and places no further orders -- a hard bankruptcy
# stop, not just a warning.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category) -- charged on ask-side (taker) fills; used as the basis for
# the maker rebate on bid-side fills too.
# NOTE: Polymarket has revised this fee schedule multiple times in 2026
# and third-party sources disagree on the exact current rate for the
# 5-min/15-min crypto sub-category specifically -- verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money. APPLY_TAKER_FEES can be set False to model a fee-free run.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
