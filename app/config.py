"""
All strategy constants live here. Nothing else in the app should hardcode
these numbers — change behavior by changing this file (or the env vars
listed below on Railway).
"""
import os

# ---- Market ---------------------------------------------------------------
ASSET_SLUG_PREFIX = os.getenv("ASSET_SLUG_PREFIX", "btc-updown-5m")
WINDOW_SECONDS = 300            # 5 minutes, fixed by Polymarket's series
GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

# ---- Strategy -------------------------------------------------------------
RUNG_PRICES = [0.40, 0.35, 0.30, 0.25]
REVERSE_RUNG_PRICES = [round(1 - price, 2) for price in RUNG_PRICES]
BASE_SIZE = 500                 # shares, starting size for every rung
SIZE_STEP = 100                 # shares removed after each win
FLOOR_SIZE = 100                # never goes below this
CAPITAL_PER_PAIR = 5000.0       # shared by each original/reverse rung pair

# ---- Polymarket crypto-market fee model -----------------------------------
TAKER_FEE_RATE = 0.07
MAKER_REBATE_POOL_SHARE = 0.20
# Paper-only proxy: actual maker rebates are paid from a daily, market-level
# pool and depend on all makers' fee-equivalent volume.
MAKER_REBATE_ESTIMATE_FACTOR = 0.20

# ---- Timing -----------------------------------------------------------
ORDER_CUTOFF_SECONDS = 270      # no new fills / resting orders honored after this
WIN_CHECK_SECONDS_BEFORE_CLOSE = 2   # "last two seconds" settlement check
WIN_PRICE_THRESHOLD = 0.95      # price above this = winner
PREFETCH_LEAD_SECONDS = 30      # look up next window's token ids this early
WINDOW_ARCHIVE_DELAY = 8        # keep a settled window "live" this long after close, for UI
MAX_HISTORY = 300               # trade log rows kept in memory

# ---- Loop ---------------------------------------------------------------
TICK_SECONDS = 1.0
PRICE_FETCH_TIMEOUT = 4.0
GAMMA_FETCH_TIMEOUT = 6.0

# ---- Mode -----------------------------------------------------------------
# This build is PAPER TRADING ONLY. No private key, no CLOB API secret, no
# real order is ever signed or sent. Fills are simulated from public CLOB
# mid/ask prices. Flip this only once a real broker implementation exists.
LIVE_TRADING_ENABLED = False
