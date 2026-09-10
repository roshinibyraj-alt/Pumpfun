"""
Central configuration for the BTC 5-min up/down paper-trading bot.
Engine 1 (streak-filtered single-side martingale) is the only strategy
running.
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

# ---- Engine 1 (v9 -- two-phase dual-bracket entry, step martingale) -----
# Phase 1: t=0s-60s (0-1 minute). Resting limit buys placed on BOTH
# sides at ENGINE1_ENTRY_PRICE simultaneously. Whichever fills first
# (price walks down to it) cancels the other side. No stop loss; TP at
# ENGINE1_PHASE1_TP. If neither side reaches the entry price by t=60s,
# both orders are cancelled -- no trade from this phase.
#
# Dead zone: t=60s-240s, nothing active.
#
# Phase 2: t=240s-300s (4-5 minutes), ONLY if Phase 1 never filled. At
# t=240s, each side is checked independently: if its price is still
# above ENGINE1_ENTRY_PRICE at that instant, a fresh resting buy is
# armed there for the rest of the window; a side already at or below
# the entry price at that check is not armed at all. Unlike Phase 1,
# neither side cancels the other here -- both can fill independently.
# Whichever fills first gets TP ENGINE1_PHASE2_TP_FIRST; if the other
# side also fills afterward, it gets TP ENGINE1_PHASE2_TP_SECOND. No
# stop loss on either leg.
#
# Anything still open at window close (from either phase) settles at
# Polymarket's real resolution, fee-free.
ENGINE1_ENTRY_PRICE = 0.10
ENGINE1_PHASE1_END = 60
ENGINE1_PHASE1_TP = 0.99
ENGINE1_PHASE2_START = 240
ENGINE1_PHASE2_TP_FIRST = 0.90
ENGINE1_PHASE2_TP_SECOND = 0.99

# Bet sizing is share-based (like the old bucket system), not a dollar
# amount converted via price. Base size stays flat through the first
# ENGINE1_MARTINGALE_TRIGGER-1 consecutive losses; the moment the
# streak reaches ENGINE1_MARTINGALE_TRIGGER, size steps up (one time,
# not compounding further per loss) to ENGINE1_BASE_SHARES *
# ENGINE1_MARTINGALE_MULT and stays there until a win resets it back to
# base. Each leg's fill uses whatever the current size is at that exact
# moment -- if Phase 2 opens two legs in one window, a settlement
# between them can change the size the second leg gets. A window with
# no trade at all (neither phase fills) never moves the streak.
ENGINE1_BASE_SHARES = 50
ENGINE1_MARTINGALE_TRIGGER = 9
ENGINE1_MARTINGALE_MULT = 2.0

# Demo capital: Engine 1 tracks a real running balance starting here. If
# it ever drops below $0 (can't cover the next bet), the engine halts and
# places no further trades -- a hard bankruptcy stop, not just a warning.
ENGINE1_STARTING_CAPITAL = 2000.0

# Maker rebate on entry fills and take-profit fills -- both are resting
# limit orders, so no fee, just a partial rebate. There is no stop loss
# in this engine, so the taker-fee path is currently unused by Engine 1.
MAKER_REBATE_FRACTION = 0.20

# Every fill that isn't closed by its TP by window close settles at
# Polymarket's real binary resolution ($1/share win, $0/share loss),
# fee-free.

# ---- Trading fees ---------------------------------------------------------
# Polymarket taker fee (per docs.polymarket.com/trading/fees, Crypto
# category), kept here for reference / potential future use. Engine 1
# currently has no stop loss, so every fill it makes is a maker order
# (entry and TP) -- this fee path is not exercised right now. Formula:
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
