"""
Central configuration for the BTC 5-min up/down bot.

Single engine -- breakout taker entry with stop loss:
  1. Watches both sides' mid-price every tick. Whichever side's mid-price
     reaches ENGINE2_TRIGGER_PRICE (0.70) first triggers a one-time taker
     market BUY of that side for ENGINE2_BASE_USD ($30) notional (crosses
     the spread, pays the taker fee). Fires at most once per window.
  2. Resting TP sell at ENGINE2_TP_PRICE (0.99) (maker).
  3. Stop loss at ENGINE2_SL_PRICE (0.29): the moment the bid drops to/
     through this level, immediately taker-sell (market order, pays taker
     fee) to guarantee the exit.
  4. If the window closes with the position still open (no TP, no SL),
     force a taker close (market sell) right at window end.
  5. Anti-martingale: base size ENGINE2_BASE_USD ($30). A win doubles the
     size for the *next window* (2x/4x/8x, up to
     ENGINE2_MAX_MARTINGALE_LEVEL doublings) -- pressing size only with
     prior winnings. A loss (SL hit, or a forced close that lost money),
     or completing the Nth (max) press level, resets size back to base.
     This bounds the *percentage* lost on any single trade (the stop-loss
     distance) but not the dollar amount, which scales with whatever
     level the streak had pressed to.
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

# ---- Breakout engine: taker entry @ 0.70, SL @ 0.29, TP @ 0.99 --------
# Sizing is anti-martingale: wins press size up, any loss resets to base.
ENGINE2_TRIGGER_PRICE = 0.70
ENGINE2_TP_PRICE = 0.99
ENGINE2_SL_PRICE = 0.29
ENGINE2_BASE_USD = 30.0
ENGINE2_MAX_MARTINGALE_LEVEL = 3  # 3 win-presses allowed after base (2x/4x/8x)

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: single source of truth for the paper balance -- debited
# on every buy fill, credited on every TP/SL/forced-close settlement.
# Halts permanently if it ever drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Entry, the stop loss, and any forced window-end close are all taker
# orders and pay the fee for real; TP is a resting maker order. Verify
# against GET https://clob.polymarket.com/fee-rate?token_id=... before
# trading real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
