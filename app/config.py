"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Single engine: dual-order entry (both sides at once, first fill wins),
sized off the previous window's winner. No martingale, no stop loss --
every filled position rides to take-profit or window resolution.
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

# ---- Engine (v11 -- dual limit orders, sized off previous winner, no filters,
#      no martingale, no SL) -----------------------------------------------
# At window open, TWO resting limit buy orders are placed simultaneously,
# both at ENGINE_ENTRY_PRICE:
#   - one on UP
#   - one on DOWN
# Sizes are asymmetric, set by which side won the PREVIOUS window:
#   - previous winner was UP   -> UP order = ENGINE_FAVORITE_SHARES,
#                                  DOWN order = ENGINE_UNDERDOG_SHARES
#   - previous winner was DOWN -> DOWN order = ENGINE_FAVORITE_SHARES,
#                                  UP order = ENGINE_UNDERDOG_SHARES
# Whichever order fills first (its side's price reaches ENGINE_ENTRY_PRICE
# first), the OTHER order is cancelled immediately -- at most one open
# position per window. If neither side reaches ENGINE_ENTRY_PRICE before
# window close, no trade happens that window.
#
# The very first window ever has no prior winner to size off of, so it's
# sat out, as is any window whose predecessor's outcome couldn't be
# determined.
#
# No filters (every eligible window gets both orders) and no martingale
# (size is always this fixed 500/250 split, win or lose).
ENGINE_ENTRY_PRICE = 0.30
ENGINE_TP = 0.99
ENGINE_FAVORITE_SHARES = 500.0   # side that won the previous window
ENGINE_UNDERDOG_SHARES = 250.0   # side that lost the previous window

# Demo capital: this is the number the dashboard's "Demo Capital" figure
# tracks. It starts here, moves with every settled trade, and is the
# single source of truth for the bot's paper balance -- nothing else in
# the app tracks money separately. If it ever drops below $0 (can't cover
# the next order's notional), the engine halts and places no further
# trades -- a hard bankruptcy stop, not just a warning.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# Maker rebate on entry fills and take-profit fills (both are resting
# limit orders, so no fee -- just a partial rebate). Polymarket's real
# maker/taker fee schedule only charges takers; since this engine has no
# market-order exits, every fill here is a maker fill and only ever
# earns the rebate, never pays the fee.
MAKER_REBATE_FRACTION = 0.20

# Every fill that hits neither TP by window close is settled at window
# resolution ($1/share win, $0/share loss), fee-free.

# ---- Trading fees (used only to size the maker rebate above) --------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category), kept here purely as the basis for the maker-rebate
# calculation above since this engine has no taker (market-order) exits.
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
