"""
Central configuration for the BTC 5-min up/down bot.

Two independent engines run on the same market/ticks and share a single
demo-capital balance (see app/engine.py for the full write-up):

Engine 1 -- resting ladder at a single rung:
  1. On the first tick of each window, unconditionally place a resting BUY
     limit order on BOTH sides at ENGINE1_ENTRY_PRICE (0.29). No wait, no
     price-band filter.
  2. Whichever side fills first -> the resting order on the OPPOSITE side
     is immediately cancelled (race, same as before but single rung).
  3. The fill gets a resting TP sell at ENGINE1_TP_PRICE (0.99). No stop
     loss -- if TP never hits, the position rides to window resolution
     ($1/share if its side won, $0 if it lost).
  4. Martingale: base size ENGINE1_BASE_USD ($10). A loss doubles the size
     for the next window (2x/4x/8x -- up to ENGINE1_MAX_MARTINGALE_LEVEL
     doublings). A win, or completing the Nth (max) martingale level,
     resets size back to base.

Engine 2 -- breakout taker entry with stop loss:
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
  5. Martingale: base size ENGINE2_BASE_USD ($30). A loss (SL hit, or a
     forced close that lost money) doubles size for the *next window*
     (2x/4x/8x, up to ENGINE2_MAX_MARTINGALE_LEVEL doublings). A win, or
     completing the Nth (max) martingale level, resets size back to base.

Both engines pull from and pay into the SAME shared balance
(config.STARTING_CAPITAL) -- there is one pot of capital, not two.
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

# ---- Engine 1: resting ladder @ 0.29 + martingale ----------------------
ENGINE1_ENTRY_PRICE = 0.29
ENGINE1_TP_PRICE = 0.99
ENGINE1_BASE_USD = 10.0
ENGINE1_MAX_MARTINGALE_LEVEL = 3  # 3 doublings allowed after base (2x/4x/8x)

# ---- Engine 2: breakout taker entry @ 0.70, SL @ 0.29, TP @ 0.99 -------
ENGINE2_TRIGGER_PRICE = 0.70
ENGINE2_TP_PRICE = 0.99
ENGINE2_SL_PRICE = 0.29
ENGINE2_BASE_USD = 30.0
ENGINE2_MAX_MARTINGALE_LEVEL = 3  # 3 doublings allowed after base (2x/4x/8x)

MAKER_REBATE_FRACTION = 0.20  # rebate earned on every resting-order fill (maker side)

# Demo capital: single source of truth for the paper balance, SHARED by
# both engines -- debited on every buy fill, credited on every TP/SL/
# resolution settlement. Halts permanently (both engines) if it ever
# drops below $0.
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))

# ---- Trading fees -----------------------------------------------------
# Engine 1 is maker-only (never crosses the spread) on both entry and
# exit. Engine 2's entry, its stop loss, and any forced window-end close
# are all taker orders and pay the fee for real; its TP is still a
# resting maker order. Verify against
# GET https://clob.polymarket.com/fee-rate?token_id=... before trading
# real money.
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc -----------------------------------------------------------------
LOG_MAX_ENTRIES = 500
