"""
Central configuration, all overridable via environment variables
(set these in Railway's Variables tab).
"""
import os


def _f(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _i(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _b(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


# ---- Mode -------------------------------------------------------------
# This bot ships in PAPER (demo) mode only: it reads Polymarket's real,
# public order books but never signs or submits a real order. All fills,
# balances, and P&L are simulated against a virtual bankroll.
PAPER_MODE = True

# ---- Bankroll / sizing --------------------------------------------------
STARTING_CAPITAL_USD = _f("STARTING_CAPITAL_USD", 2000.0)
SHARES_PER_LEG = _i("SHARES_PER_LEG", 300)

# ---- Strategy thresholds -------------------------------------------------
ENTRY_COMBINED_PRICE = _f("ENTRY_COMBINED_PRICE", 0.85)   # buy when combined ask < this
EXIT_COMBINED_PRICE = _f("EXIT_COMBINED_PRICE", 1.15)     # sell when combined bid >= this
# (only applies to pairs listed in TP_PAIR_IDS below)

# Taker-only execution: we always cross the spread so fills are (almost)
# guaranteed, capped by a slippage ceiling/floor so we never chase a
# runaway book.
BUY_SLIPPAGE_CEILING = _f("BUY_SLIPPAGE_CEILING", 0.99)   # never pay more than this per share
SELL_SLIPPAGE_FLOOR = _f("SELL_SLIPPAGE_FLOOR", 0.01)     # never accept less than this per share

# How many ticks after firing an order we wait before logging the
# "post-fill" book snapshot (impact check requested by the user).
POST_FILL_CHECK_TICKS = _i("POST_FILL_CHECK_TICKS", 2)

# ---- Fees -----------------------------------------------------------------
# Polymarket crypto-category markets charge a dynamic TAKER-only fee:
#   fee_usd = shares * fee_rate * price * (1 - price)
# Makers pay 0. We read the live fee_rate from each market's own
# feeSchedule via Gamma at discovery time; this is only the fallback
# used if that field is ever missing.
FALLBACK_TAKER_FEE_RATE = _f("FALLBACK_TAKER_FEE_RATE", 0.07)

# ---- Polling ---------------------------------------------------------------
POLL_INTERVAL_SECONDS = _f("POLL_INTERVAL_SECONDS", 1.5)
RESOLUTION_POLL_SECONDS = _f("RESOLUTION_POLL_SECONDS", 2.0)
RESOLUTION_POLL_TIMEOUT_SECONDS = _f("RESOLUTION_POLL_TIMEOUT_SECONDS", 180.0)

# ---- Assets / market discovery ---------------------------------------------
ASSETS = ["btc", "eth"]  # gamma slug prefixes
WINDOW_SECONDS = 300

GAMMA_BASE = os.getenv("GAMMA_BASE", "https://gamma-api.polymarket.com")
CLOB_BASE = os.getenv("CLOB_BASE", "https://clob.polymarket.com")

# ---- Storage ---------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "/data/bot_state.db" if os.path.isdir("/data") else "bot_state.db")

# ---- Web server -------------------------------------------------------------
PORT = _i("PORT", 8080)

# ---- Pair definitions --------------------------------------------------------
# Each pair buys/sells BOTH legs together. "Up"/"Down" refer to the
# outcome index within each asset's own market (index 0 = Up, 1 = Down).
#
# TP assignment is DYNAMIC (decided at runtime by the strategy loop, not
# fixed here): whichever pair fires first in a window gets the
# intra-window take-profit and is locked (no re-entry) once it hits;
# whichever pair fires second gets no take-profit at all and is simply
# held to resolution. See app/strategy.py.
PAIR_DEFS = {
    "BTC_UP_ETH_DOWN": (("btc", "Up"), ("eth", "Down")),
    "BTC_DOWN_ETH_UP": (("btc", "Down"), ("eth", "Up")),
}
