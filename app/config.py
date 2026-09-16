"""
Central configuration, all overridable via environment variables
(set these in Railway's Variables tab).
"""
import os
from dataclasses import dataclass
from typing import Optional


def _f(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _i(name: str, default: int) -> int:
    return int(os.getenv(name, default))


# ---- Mode -------------------------------------------------------------
PAPER_MODE = True

# ---- Window -------------------------------------------------------------
WINDOW_SECONDS = _i("WINDOW_SECONDS", 300)      # 5-minute windows
WINDOW_LABEL = os.getenv("WINDOW_LABEL", "5m")
ASSET = os.getenv("ASSET", "btc")                # BTC only

# ---- Capital -------------------------------------------------------------
STARTING_CAPITAL_PER_ENGINE = _f("STARTING_CAPITAL_PER_ENGINE", 500.0)
SHARES_PER_TRADE = _f("SHARES_PER_TRADE", 100.0)

# ---- Take-profit (universal) --------------------------------------------------
# Special rule from the spec: hitting TP is booked as a clean $1.00/share
# payout with NO exit fee -- treated identically to a winning resolution,
# not an actual market sale at 0.99. Applies to all 9 engines.
TAKE_PROFIT_TRIGGER_PRICE = _f("TAKE_PROFIT_TRIGGER_PRICE", 0.99)
TAKE_PROFIT_PAYOUT_PRICE = _f("TAKE_PROFIT_PAYOUT_PRICE", 1.00)

# ---- Fees -------------------------------------------------------------------
FALLBACK_TAKER_FEE_RATE = _f("FALLBACK_TAKER_FEE_RATE", 0.07)

# ---- Resolution (hold-to-close path) ------------------------------------------
GAMMA_RESOLUTION_CONFIDENCE = _f("GAMMA_RESOLUTION_CONFIDENCE", 0.99)
GAMMA_RESOLUTION_TIMEOUT_SECONDS = _f("GAMMA_RESOLUTION_TIMEOUT_SECONDS", 90.0)
CLOB_FALLBACK_PRICE_THRESHOLD = _f("CLOB_FALLBACK_PRICE_THRESHOLD", 0.97)

# ---- Polling ---------------------------------------------------------------
POLL_INTERVAL_SECONDS = _f("POLL_INTERVAL_SECONDS", 1.0)
RESOLUTION_POLL_SECONDS = _f("RESOLUTION_POLL_SECONDS", 1.5)
RESOLUTION_POLL_TIMEOUT_SECONDS = _f("RESOLUTION_POLL_TIMEOUT_SECONDS", 180.0)

# ---- Market discovery ---------------------------------------------------------
GAMMA_BASE = os.getenv("GAMMA_BASE", "https://gamma-api.polymarket.com")
CLOB_BASE = os.getenv("CLOB_BASE", "https://clob.polymarket.com")

# ---- Storage ---------------------------------------------------------------
DB_PATH = os.getenv("DB_PATH", "/data/nine_engine_bot_state.db" if os.path.isdir("/data") else "nine_engine_bot_state.db")

# ---- Web server -------------------------------------------------------------
PORT = _i("PORT", 8080)


# ---- Engine definitions -------------------------------------------------------
@dataclass(frozen=True)
class EngineConfig:
    label: str
    kind: str                      # "limit_cancel_skip" (E1-E5) or "taker_momentum" (E6-E9)
    price: float                   # entry limit price (1-5) or momentum trigger price (6-9)
    skip_length: Optional[int]     # only for limit_cancel_skip
    sl_price: Optional[float]      # only for taker_momentum
    color: str                     # ANSI color name for logging


ENGINES = [
    EngineConfig(label="E1", kind="limit_cancel_skip", price=0.10, skip_length=5, sl_price=None, color="cyan"),
    EngineConfig(label="E2", kind="limit_cancel_skip", price=0.20, skip_length=4, sl_price=None, color="magenta"),
    EngineConfig(label="E3", kind="limit_cancel_skip", price=0.30, skip_length=3, sl_price=None, color="green"),
    EngineConfig(label="E4", kind="limit_cancel_skip", price=0.40, skip_length=2, sl_price=None, color="yellow"),
    EngineConfig(label="E5", kind="limit_cancel_skip", price=0.50, skip_length=1, sl_price=None, color="blue"),
    EngineConfig(label="E6", kind="taker_momentum", price=0.60, skip_length=None, sl_price=0.20, color="red"),
    EngineConfig(label="E7", kind="taker_momentum", price=0.70, skip_length=None, sl_price=0.30, color="bright_magenta"),
    EngineConfig(label="E8", kind="taker_momentum", price=0.80, skip_length=None, sl_price=0.40, color="bright_cyan"),
    EngineConfig(label="E9", kind="taker_momentum", price=0.90, skip_length=None, sl_price=0.50, color="white"),
]
