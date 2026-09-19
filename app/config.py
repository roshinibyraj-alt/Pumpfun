"""Configuration for the directional BTC 5-minute prediction bot.

The bot buys the side opposite to the multi-timeframe signal by default.
A signal is tradable only when the learned probability and cross-timeframe
alignment clear their configured thresholds.
"""
import os

# ---- Mode ------------------------------------------------------------------
TRADING_MODE = os.getenv("TRADING_MODE", "paper")

# ---- Market discovery / timing --------------------------------------------
GAMMA_API_BASE = os.getenv("GAMMA_API_BASE", "https://gamma-api.polymarket.com")
CLOB_API_BASE = os.getenv("CLOB_API_BASE", "https://clob.polymarket.com")
SLUG_PREFIX = "btc-updown-5m-"
WINDOW_SECONDS = 300
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "1.0"))

# ---- Order sizing / pricing ------------------------------------------------
ORDER_SHARES = float(os.getenv("ORDER_SHARES", "200"))
ENTRY_DELAY_SECONDS = float(os.getenv("ENTRY_DELAY_SECONDS", "2"))
TP_PRICE = float(os.getenv("TP_PRICE", "0.99"))
SIGNAL_CANDLE_OFFSET = 240

# Buy the opposite outcome from the model signal by default. Set this to
# false when testing the non-faded strategy.
FADE_SIGNAL = os.getenv("FADE_SIGNAL", "true").strip().lower() in {
    "1", "true", "yes", "on"
}

# ---- Multi-timeframe prediction -------------------------------------------
TIMEFRAME_LABELS = ("1d", "4h", "1h", "15m")
AI_LEARNING_RATE = float(os.getenv("AI_LEARNING_RATE", "0.035"))
AI_L2_REG = float(os.getenv("AI_L2_REG", "0.002"))
AI_MODEL_WEIGHT = float(os.getenv("AI_MODEL_WEIGHT", "0.70"))
AI_MIN_CONFIDENCE = float(os.getenv("AI_MIN_CONFIDENCE", "0.56"))
AI_MIN_ALIGNMENT = float(os.getenv("AI_MIN_ALIGNMENT", "0.35"))
AI_MIN_BARS_PER_TIMEFRAME = int(os.getenv("AI_MIN_BARS_PER_TIMEFRAME", "35"))

# The backtest is exactly the most recent week. A longer warm-up is fetched
# only so 1D MACD/EMA/RSI values have enough completed candles to be useful.
AI_BACKTEST_DAYS = float(os.getenv("AI_BACKTEST_DAYS", "7"))
AI_WARMUP_DAYS = float(os.getenv("AI_WARMUP_DAYS", "45"))
AI_BACKTEST_BASE_URL = os.getenv(
    "AI_BACKTEST_BASE_URL", "https://api.binance.com/api/v3/klines"
)

# ---- Capital / fees --------------------------------------------------------
STARTING_CAPITAL = float(os.getenv("STARTING_CAPITAL", "2000"))
APPLY_TAKER_FEES = True
TAKER_FEE_RATE = 0.07
TAKER_FEE_EXPONENT = 1

# ---- Misc ------------------------------------------------------------------
LOG_MAX_ENTRIES = 500