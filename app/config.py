"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- two fully independent momentum ladders (one per side,
UP and DOWN never affect each other), each with two zones of buy-strength
entries and universal TP at 0.99 (redeem $1.00/share):

ZONE A (0.60 -> 0.90): placed all at once, immediately, the instant the
window opens. These are momentum entry rungs: they fill when the ask
rises through each rung:
    0.60 -> 50 shares
    0.70 -> 100 shares
    0.80 -> 200 shares
    0.90 -> 400 shares

ZONE B (confirmation entries): each rung is placed ONCE, only after its
own strength trigger is first reached (checked independently every tick):
    price reaches 0.60 -> place momentum buy @ 0.70, 100 shares
    price reaches 0.70 -> place momentum buy @ 0.80, 200 shares
    price reaches 0.80 -> place momentum buy @ 0.90, 400 shares

Both zones are always live at once -- nothing about one disables the
other. This is intentionally the reverse of the old dip-buy ladder:
entries are activated by rising strength (`ask >= entry price`), not by
falling price (`ask <= entry price`).

Zone B activates 2 minutes (120s) after window opens.

Universal TP at 0.99: if mid >= 0.99, redeem all held shares at
$1.00/share (fee-free). No stop-loss.

Window close: cancel any still-resting buy orders (no penalty) and
force a taker close (real fee, real depth-weighted price) on any shares
still held.
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

POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Two-zone momentum ladder ----------------------------------------------
# (entry_price, shares) -- placed immediately at window open, both sides.
# Entries fill when the ask rises through the rung.
ZONE_A_RUNGS = [(0.60, 50.0), (0.70, 100.0), (0.80, 200.0), (0.90, 400.0)]

# (strength_trigger, entry_price, shares) -- entry rung is placed once
# the strength trigger is first reached; each trigger is independent.
ZONE_B_RUNGS = [
    (0.60, 0.70, 100.0),
    (0.70, 0.80, 200.0),
    (0.80, 0.90, 400.0),
]
ZONE_B_DELAY_SECONDS = 120     # Zone B activates 2 minutes after window opens


STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Every buy rung and the dynamic sell are resting MAKER limit orders --
# they fill at their own limit price with no fee. Only a forced
# window-end close is a TAKER market order and pays the fee for real,
# priced by walking real book depth. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
