"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- two fully independent ladders (one per side, UP and
DOWN never affect each other), each with two "zones" of resting limit
buys and one dynamically-requoted limit sell:

ZONE A (0.40 -> 0.10): placed all at once, immediately, the instant the
window opens -- no trigger needed:
    0.40 -> 50 shares
    0.30 -> 100 shares
    0.20 -> 200 shares
    0.10 -> 400 shares

ZONE B (0.60 -> 0.90): each rung is placed ONCE, only after its own
trigger price is first reached (checked independently every tick, not
sequentially -- reaching 0.90 doesn't require 0.70 or 0.80 to have
triggered first):
    price reaches 0.70 -> place resting buy @ 0.60, 100 shares
    price reaches 0.80 -> place resting buy @ 0.70, 200 shares
    price reaches 0.90 -> place resting buy @ 0.80, 400 shares

Both zones are always live at once -- nothing about one disables the
other. All buy rungs are maker limit orders (fill at their own exact
price, no fee) the moment that side's ask reaches them.

Exit: the instant ANY rung fills (zone A or B), recompute the average
entry price across every share held so far on that side, cancel the
currently-resting sell order (if any), and place a fresh resting limit
sell at (avg_entry + SELL_OFFSET) for the full held size. This can move
the sell price either direction on a later fill -- a Zone B fill (higher
price) pulls the average up, a Zone A fill (lower price) pulls it down.
It's a full re-quote each time, not a one-way ratchet. There is no
stop-loss anywhere in this design.

If the sell fills, that side is flat again but its still-resting
(unfilled) buy rungs stay live -- a later fill can start a fresh
accumulation / sell-requote cycle within the same window.

Window close: cancel any still-resting buy/sell orders (no penalty) and
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

# ---- Two-zone ladder + dynamic re-quoted sell ----------------------------
# (price, shares) -- placed immediately at window open, both sides.
ZONE_A_RUNGS = [(0.40, 50.0), (0.30, 100.0), (0.20, 200.0), (0.10, 400.0)]

# (trigger_price, order_price, shares) -- order_price rung is placed
# once trigger_price is first reached, each trigger independent.
ZONE_B_RUNGS = [
    (0.70, 0.60, 100.0),
    (0.80, 0.70, 200.0),
    (0.90, 0.80, 400.0),
]

SELL_OFFSET = 0.10          # resting sell quoted at avg_entry + this, re-quoted after every fill
SELL_PRICE_CAP = 0.99       # never quote a sell at/above this, regardless of avg entry

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
