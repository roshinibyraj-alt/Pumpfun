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

# ---- Startup behavior -------------------------------------------------
# This bot deliberately does NOT copy positions the master already had open
# before it started. On boot it only records the master's recent trade
# history as "already seen" (so nothing gets replayed), then copies every
# NEW trade the master places from that moment forward.
STARTUP_TRADE_LOOKBACK = 200   # trades fetched at startup just to seed the "already seen" set

# ---- History / limits -------------------------------------------------
MAX_TRADE_LOG = 500
POSITION_DUST_SHARES = 0.5      # a position below this is treated as fully closed
