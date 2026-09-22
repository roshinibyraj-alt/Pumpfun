"""Configuration for the CLOB-only BTC 5-minute binary bot."""
import os


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


TRADING_MODE = os.getenv("TRADING_MODE", "paper")
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# Orders are sized in USDC notional; shares are derived from execution price.
# Dollar sizing ladder: $500 -> $400 -> $300 -> $200 -> $100 -> $0.
BASE_ORDER_USD = float(os.getenv("BASE_ORDER_USD", os.getenv("ORDER_USD", "500")))
WIN_STEP_USD = float(os.getenv("WIN_STEP_USD", "100"))
# Compatibility alias for callers that only need the base order size.
ORDER_USD = BASE_ORDER_USD
LIMIT_ENTRY_PRICE = float(os.getenv("LIMIT_ENTRY_PRICE", "0.40"))
LIMIT_ORDER_TIMEOUT_SECONDS = float(os.getenv("LIMIT_ORDER_TIMEOUT_SECONDS", "30"))
TAKER_ENTRY_MAX_PRICE = float(os.getenv("TAKER_ENTRY_MAX_PRICE", "0.60"))
WINNER_THRESHOLD = float(os.getenv("WINNER_THRESHOLD", "0.95"))
FINAL_SECOND_SECONDS = float(os.getenv("FINAL_SECOND_SECONDS", "1.0"))

STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "5000"))
APPLY_TAKER_FEES = _bool("APPLY_TAKER_FEES", True)
TAKER_FEE_RATE = float(os.getenv("TAKER_FEE_RATE", "0.07"))
TAKER_FEE_EXPONENT = float(os.getenv("TAKER_FEE_EXPONENT", "1"))
MAKER_REBATE_RATE = float(os.getenv("MAKER_REBATE_RATE", "0.20"))

LOG_MAX_ENTRIES = int(os.getenv("LOG_MAX_ENTRIES", "500"))
LOG_FILE_PATH = os.getenv("LOG_FILE_PATH", "logs/bot-events.jsonl")
LOG_FILE_MAX_BYTES = int(os.getenv("LOG_FILE_MAX_BYTES", str(10 * 1024 * 1024)))
LATE_JOIN_GRACE_SECONDS = float(os.getenv("LATE_JOIN_GRACE_SECONDS", "10"))
