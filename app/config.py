"""
Central config for the copy-trading demo bot. Change behavior here.
"""
import os

# ---- Master wallet to copy -------------------------------------------
MASTER_WALLET = os.getenv("MASTER_WALLET", "0x2005d16a84ceefa912d4e380cd32e7ff827875ea")

# ---- Copy parameters ----------------------------------------------------
COPY_RATIO = 0.10               # copy 10% of every master position/trade
DEMO_CAPITAL = 10_000.0         # starting paper bankroll

# ---- APIs (all public, no auth required) ---------------------------------
DATA_API = "https://data-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"

# ---- Timing ---------------------------------------------------------------
TRADE_POLL_SECONDS = 6           # how often to check the master wallet for new fills
PRICE_REFRESH_SECONDS = 6        # how often to re-mark open positions to market
STATS_REFRESH_SECONDS = 120      # how often to refresh the master's profile stats
HTTP_TIMEOUT = 8.0

# ---- Bootstrap ------------------------------------------------------------
# On startup, copy every position the master currently holds at COPY_RATIO,
# then switch to live trade-by-trade copying for everything from that point on.
BOOTSTRAP_ON_START = True
BOOTSTRAP_TRADE_LOOKBACK = 200   # trades fetched at startup just to seed the "already seen" set

# ---- History / limits -------------------------------------------------
MAX_TRADE_LOG = 500
POSITION_DUST_SHARES = 0.5      # a position below this is treated as fully closed
