"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Single engine: streak-filtered single-side entry with a martingale
ladder. No stop loss -- every position that doesn't hit take-profit
rides to Polymarket's real resolution.
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

# How many seconds to retry Polymarket's real settlement outcome before
# falling back to a last-observed-price approximation.
RESOLUTION_RETRY_SECONDS = 6

# ---- Engine (v9 -- streak-filtered single-side entry, martingale, no SL) -
# At window open, a resting limit buy is placed at ENGINE_ENTRY_PRICE on
# ONLY the side that won the PREVIOUS window (real resolution, not a
# guess). If the same side has won ENGINE_STREAK_FILTER_LENGTH windows in
# a row, the engine places no order at all and sits out entirely until a
# window resolves with the opposite side winning -- that flip becomes the
# new streak (count 1) and trading resumes on it next window. The very
# first window ever has no prior result, so it's sat out too.
#
# Exit via TP or Polymarket's real resolution at window close -- there is
# no stop loss, so a losing position always rides to $0/share rather than
# being cut early. This raises per-loss severity versus a bot with an SL;
# it does not change how often a side wins.
ENGINE_ENTRY_PRICE = 0.30
ENGINE_TP = 0.99
ENGINE_BASE_BET = 30.0          # dollars
ENGINE_MARTINGALE_MULT = 1.7    # next bet = prev bet * this, after a loss
ENGINE_STREAK_FILTER_LENGTH = 3
# A win (TP or resolution win) resets the next bet back to ENGINE_BASE_BET.
# A window with no trade -- whether from the streak filter or because
# price never reached the entry price -- does not affect the bet ladder;
# the martingale only moves on an actual trade result.

# Demo capital: this is the number the dashboard's "Demo Capital" figure
# tracks. It starts here, moves with every settled trade, and is the
# single source of truth for the bot's paper balance -- nothing else in
# the app tracks money separately. If it ever drops below $0 (can't cover
# the next bet), the engine halts and places no further trades -- a hard
# bankruptcy stop, not just a warning.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# Maker rebate on entry fills and take-profit fills (both are resting
# limit orders, so no fee -- just a partial rebate). Polymarket's real
# maker/taker fee schedule only charges takers; since this engine no
# longer has a market-order stop-loss exit, every fill here is a maker
# fill and only ever earns the rebate, never pays the fee.
MAKER_REBATE_FRACTION = 0.20

# Every fill that hits neither TP by window close is settled at
# Polymarket's real binary resolution ($1/share win, $0/share loss),
# fee-free.

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
