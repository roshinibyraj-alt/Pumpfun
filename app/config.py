"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Engine A has been removed. Engine B is the only strategy running.
"""
import os

# ---- Mode -------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Capital ------------------------------------------------------------
STARTING_BALANCE_USDC = float(os.getenv("STARTING_BALANCE_USDC", "5000"))

# ---- Market discovery ---------------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# How many seconds before window close counts as the "resolution window"
# for the logging-only 0.90+ signal.
RESOLUTION_WINDOW_SECONDS = 2.0

# How many seconds to retry Polymarket's real settlement outcome before
# falling back to a last-observed-price approximation.
RESOLUTION_RETRY_SECONDS = 6

# ---- Engine 1 (v8 -- streak-filtered single-side entry, martingale) -----
# At window open, a resting limit buy is placed at ENGINE1_ENTRY_PRICE on
# ONLY the side that won the PREVIOUS window (no more dual-side race).
# If the same side has won ENGINE1_STREAK_FILTER_LENGTH windows in a row,
# Engine 1 places no order at all and sits out entirely until a window
# resolves with the opposite side winning -- that flip becomes the new
# streak (count 1) and trading resumes on it next window. The very first
# window ever has no prior result, so it's sat out too.
#
# Exit via TP, SL, or Polymarket's real resolution if neither fires by
# window close.
ENGINE1_ENTRY_PRICE = 0.30
ENGINE1_TP = 0.99
ENGINE1_SL = 0.05
ENGINE1_BASE_BET = 30.0          # dollars
ENGINE1_MARTINGALE_MULT = 1.7    # next bet = prev bet * this, after a loss
ENGINE1_STREAK_FILTER_LENGTH = 3
# A win (TP or resolution win) resets the next bet back to ENGINE1_BASE_BET.
# A window with no trade -- whether from the streak filter or because
# price never reached the entry price -- does not affect the bet ladder;
# the martingale only moves on an actual trade result.

# Demo capital: Engine 1 tracks a real running balance starting here. If
# it ever drops below $0 (can't cover the next bet), the engine halts and
# places no further trades -- a hard bankruptcy stop, not just a warning.
ENGINE1_STARTING_CAPITAL = 2000.0

# ---- Engine 2 (v7 -- delayed dip-fill entry, martingale) -----------------
# Does nothing for the first ENGINE2_WAIT_SECONDS of the window. After
# that, watches both sides: the first time either side's price is
# observed at or above ENGINE2_ENTRY_PRICE, a resting limit buy is armed
# there -- but it only actually fills once price later trades back down
# AT OR BELOW that level (real limit-order semantics; it does not fill
# just because price is sitting above the level). If price never comes
# back down, no trade happens that window. Only one position per window.
ENGINE2_WAIT_SECONDS = 120
ENGINE2_ENTRY_PRICE = 0.70
ENGINE2_TP = 0.99
ENGINE2_SL = 0.40
ENGINE2_BASE_BET = 100.0
ENGINE2_MARTINGALE_MULT = 2.0
# Same win-resets / no-trade-doesn't-affect-ladder rules as Engine 1.
# Engine 2 has no capital cap / bankruptcy stop -- that's currently an
# Engine-1-only feature, added at the user's request in that context.

# Maker rebate on entry fills and take-profit fills (both are resting
# limit orders, so no fee -- just a partial rebate). Stop-loss exits are
# market orders and pay the full taker fee with no rebate, matching
# Polymarket's real maker/taker treatment.
MAKER_REBATE_FRACTION = 0.20

# Every fill that hits neither TP nor SL by window close is settled at
# Polymarket's real binary resolution ($1/share win, $0/share loss),
# fee-free.

# ---- Trading fees ---------------------------------------------------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category). Charged only on stop-loss market-order exits here; entry
# and take-profit fills are maker orders and pay no fee (see
# MAKER_REBATE_FRACTION above). Formula:
#   fee = shares * price * FEE_RATE * (price * (1 - price)) ** FEE_EXPONENT
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
