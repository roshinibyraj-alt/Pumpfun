"""Configuration for the CLOB-only BTC 5-minute binary bot."""
import os


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


TRADING_MODE = os.getenv("TRADING_MODE", "live").strip().lower()
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# Orders are sized in USDC notional; shares are derived from execution price.
# The exact win ladder is explicit so a skipped or extra step cannot be
# introduced accidentally by changing a decrement value.
def _order_ladder(raw: str) -> tuple[float, ...]:
    values = tuple(float(part.strip()) for part in raw.split(",") if part.strip())
    if not values or values[0] <= 0 or any(value < 0 for value in values):
        raise ValueError("ORDER_LADDER_USD must start above zero and contain no negative values")
    if any(left <= right for left, right in zip(values, values[1:])):
        raise ValueError("ORDER_LADDER_USD must be strictly descending")
    if values[-1] != 0:
        values = (*values, 0.0)
    return values


ORDER_LADDER_USD = _order_ladder(os.getenv("ORDER_LADDER_USD", "5,4,3,2,1,0"))
BASE_ORDER_USD = ORDER_LADDER_USD[0]
# Compatibility aliases for callers and older dashboard fields.
WIN_STEP_USD = float(os.getenv("WIN_STEP_USD", "1"))
ORDER_USD = BASE_ORDER_USD
LIMIT_ENTRY_PRICE = float(os.getenv("LIMIT_ENTRY_PRICE", "0.40"))
LIMIT_ORDER_TIMEOUT_SECONDS = float(os.getenv("LIMIT_ORDER_TIMEOUT_SECONDS", "30"))
TAKER_ENTRY_MAX_PRICE = float(os.getenv("TAKER_ENTRY_MAX_PRICE", "0.60"))

# Live entries: trigger below these prices, then submit a FOK BUY with the
# highest valid market price (effectively no price protection).
LIVE_FIRST_PHASE_SECONDS = float(os.getenv("LIVE_FIRST_PHASE_SECONDS", "30"))
LIVE_FIRST_PHASE_TRIGGER = float(os.getenv("LIVE_FIRST_PHASE_TRIGGER", "0.40"))
LIVE_SECOND_PHASE_TRIGGER = float(os.getenv("LIVE_SECOND_PHASE_TRIGGER", "0.50"))
LIVE_MAX_PRICE = float(os.getenv("LIVE_MAX_PRICE", "0.99"))
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
