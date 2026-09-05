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
# NOTE: starting capital is now per-instance (5m and 15m are fully
# independent bankrolls) -- see INSTANCES at the bottom of this file.

# Base size for every window, unless a decorrelation boost is active (see
# below). "Decorrelation" = a resolved position where BOTH legs lost --
# i.e. the actual BTC/ETH outcome was the exact opposite combo of the
# pair that was bought (e.g. bet BTC-Up+ETH-Down, but BTC actually went
# Down and ETH actually went Up). When that happens, the very next window
# whose entries haven't fired yet uses BOOSTED_SHARES_PER_LEG instead of
# BASE_SHARES_PER_LEG; the window after that reverts to base regardless
# of how the boosted window turned out (win, partial loss, or another
# decorrelation -- which would just re-arm the boost for one more window).
# This sizing rule is shared by both the 5m and 15m instances, but each
# tracks its own boost state independently (a decorrelation on 5m never
# affects 15m's sizing, and vice versa).
BASE_SHARES_PER_LEG = _i("BASE_SHARES_PER_LEG", 10)
BOOSTED_SHARES_PER_LEG = _i("BOOSTED_SHARES_PER_LEG", 300)

# ---- Strategy thresholds -------------------------------------------------
ENTRY_COMBINED_PRICE = _f("ENTRY_COMBINED_PRICE", 0.85)   # buy when combined ask < this
EXIT_COMBINED_PRICE = _f("EXIT_COMBINED_PRICE", 1.15)     # sell when combined bid >= this
# (TP eligibility is decided dynamically at runtime by trigger order --
# whichever pair fires first in a window gets it -- see app/strategy.py)

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

# ---- Resolution -------------------------------------------------------------
# Resolution is determined PURELY from live CLOB prices -- no Gamma
# outcomePrices/closed check, no fallback path. Once a position's window
# has ended, each leg the position actually holds is re-priced from its
# own order book (last trade price, or best bid if no trade yet). A leg
# is a confirmed winner at price >= RESOLUTION_PRICE_THRESHOLD ($1/share)
# or a confirmed loser at price <= 1 - RESOLUTION_PRICE_THRESHOLD
# ($0/share). If a leg's price is still ambiguous, resolution keeps
# polling (see RESOLUTION_POLL_SECONDS) rather than guessing.
RESOLUTION_PRICE_THRESHOLD = _f("RESOLUTION_PRICE_THRESHOLD", 0.97)

# ---- Polling ---------------------------------------------------------------
POLL_INTERVAL_SECONDS = _f("POLL_INTERVAL_SECONDS", 1.5)
RESOLUTION_POLL_SECONDS = _f("RESOLUTION_POLL_SECONDS", 2.0)
RESOLUTION_POLL_TIMEOUT_SECONDS = _f("RESOLUTION_POLL_TIMEOUT_SECONDS", 180.0)

# ---- Assets / market discovery ---------------------------------------------
ASSETS = ["btc", "eth"]  # gamma slug prefixes

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

# ---- Window instances -------------------------------------------------------
# The bot runs TWO completely independent trading instances side by side:
# a 5-minute window bot and a 15-minute window bot. "Independent" means
# independent everything -- separate virtual bankroll, separate open
# positions / awaiting-resolution queues, separate decorrelation-boost
# state, separate storage rows, separate loggers (with their own color),
# and their own panel on the dashboard. They never share capital or state.
# Every other strategy parameter above (entry/exit thresholds, sizing,
# fees, resolution threshold, etc.) is applied identically to both.
from dataclasses import dataclass


@dataclass(frozen=True)
class WindowInstanceConfig:
    label: str            # "5m" / "15m" -- used in logger names, storage keys, dashboard
    window_seconds: int
    slug_label: str        # gamma slug segment: "{asset}-updown-{slug_label}-{ts}"
    starting_capital: float
    color: str              # ANSI color name used by the logging formatter


INSTANCES = [
    WindowInstanceConfig(
        label="5m",
        window_seconds=_i("WINDOW_SECONDS_5M", 300),
        slug_label=os.getenv("WINDOW_SLUG_5M", "5m"),
        starting_capital=_f("STARTING_CAPITAL_5M", 2000.0),
        color="cyan",
    ),
    WindowInstanceConfig(
        label="15m",
        window_seconds=_i("WINDOW_SECONDS_15M", 900),
        slug_label=os.getenv("WINDOW_SLUG_15M", "15m"),
        starting_capital=_f("STARTING_CAPITAL_15M", 2000.0),
        color="magenta",
    ),
]
