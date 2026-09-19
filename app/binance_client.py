"""Binance BTC/USDT candles used by the multi-timeframe signal engine.

The websocket supplies closed 1-minute candles while startup REST data
provides enough history to calculate completed 15m, 1h, 4h and 1d bars.
The feed deliberately exposes only completed higher-timeframe bars so a
signal can never read future candles or a partially formed bar.
"""
import asyncio
import bisect
import json
import time
from dataclasses import dataclass
from typing import Optional

import websockets

STREAM_URL = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m"
MAX_CANDLES = 70_000        # about 48 days of 1-minute history
RECONNECT_BACKOFF_SECONDS = 3


@dataclass
class Candle:
    open_time: float   # unix seconds, minute-aligned
    open: float
    close: float
    closed: bool        # True once Binance has sent the final update for this candle
    high: Optional[float] = None
    low: Optional[float] = None
    volume: float = 0.0


class BinanceKlineFeed:
    def __init__(self):
        self.candles: "dict[float, Candle]" = {}
        self.connected = False
        self.last_error: Optional[str] = None
        self.last_message_ts: Optional[float] = None
        self._stop = False
        self._task: Optional[asyncio.Task] = None
        self._candle_revision = 0
        self._timeframe_cache = {}

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop = True
        if self._task:
            self._task.cancel()

    async def _run(self):
        while not self._stop:
            try:
                async with websockets.connect(STREAM_URL, ping_interval=20, ping_timeout=20) as ws:
                    self.connected = True
                    self.last_error = None
                    async for raw in ws:
                        self._handle_message(raw)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.connected = False
                self.last_error = f"{type(e).__name__}: {e}"
            if not self._stop:
                await asyncio.sleep(RECONNECT_BACKOFF_SECONDS)

    def _handle_message(self, raw: str):
        try:
            data = json.loads(raw)
            k = data.get("k") or {}
            open_time_ms = k.get("t")
            open_price = k.get("o")
            high_price = k.get("h")
            low_price = k.get("l")
            close_price = k.get("c")
            volume = k.get("v")
            is_closed = bool(k.get("x", False))
            if (open_time_ms is None or open_price is None or high_price is None
                    or low_price is None or close_price is None or volume is None):
                return
            open_time_s = open_time_ms / 1000.0
            self.candles[open_time_s] = Candle(
                open_time=open_time_s,
                open=float(open_price),
                close=float(close_price),
                closed=is_closed,
                high=float(high_price),
                low=float(low_price),
                volume=float(volume),
            )
            if is_closed:
                self._candle_revision += 1
                self._timeframe_cache.clear()
            self.last_message_ts = time.time()
            self._trim()
        except Exception:
            pass  # a single malformed message should never kill the feed

    def _trim(self):
        if len(self.candles) > MAX_CANDLES:
            oldest = sorted(self.candles)[: len(self.candles) - MAX_CANDLES]
            for k in oldest:
                del self.candles[k]

    def get_candle(self, minute_open_ts: float) -> Optional[Candle]:
        """minute_open_ts: unix seconds for the start of the target minute
        (any timestamp within that minute is fine -- it's floored here)."""
        key = int(minute_open_ts // 60) * 60
        return self.candles.get(float(key))

    def get_recent_closes(self, end_open_ts: float, count: int) -> Optional[list]:
        """`count` consecutive closed-candle closes, oldest -> newest,
        ending at (and including) the minute containing end_open_ts.
        Returns None if any minute in that span is missing or its candle
        hasn't closed yet -- caller must not compute on a partial series."""
        end_key = int(end_open_ts // 60) * 60
        closes = []
        for i in range(count - 1, -1, -1):
            c = self.candles.get(float(end_key - i * 60))
            if c is None or not c.closed:
                return None
            closes.append(c.close)
        return closes

    def get_rsi(self, end_open_ts: float, period: int) -> Optional[float]:
        """Simple (non-Wilder) RSI over `period` 1-minute closes ending at
        end_open_ts. None if there isn't a full, uninterrupted run of
        period+1 closed candles yet (e.g. right after startup/reconnect)."""
        closes = self.get_recent_closes(end_open_ts, period + 1)
        if closes is None:
            return None
        gains, losses = 0.0, 0.0
        for i in range(1, len(closes)):
            diff = closes[i] - closes[i - 1]
            if diff >= 0:
                gains += diff
            else:
                losses += -diff
        avg_gain, avg_loss = gains / period, losses / period
        if avg_loss == 0:
            return 100.0
        rs = avg_gain / avg_loss
        return 100.0 - (100.0 / (1.0 + rs))

    def get_timeframe_bars(self, timeframe_seconds: int, as_of_ts: float,
                           min_bars: int = 1) -> Optional[list]:
        """Aggregate complete 1-minute candles into completed timeframe bars.

        `as_of_ts` is the decision boundary. A timeframe bucket is included
        only when its final minute has closed by that boundary and every
        minute in the bucket exists. Missing minutes are treated as a data
        gap rather than silently producing misleading indicators.
        """
        if timeframe_seconds % 60:
            raise ValueError("timeframe_seconds must be a multiple of 60")
        minute_count = timeframe_seconds // 60
        cache_key = (timeframe_seconds, self._candle_revision)
        out = self._timeframe_cache.get(cache_key)
        if out is None:
            buckets = {}
            for key, candle in self.candles.items():
                if not candle.closed:
                    continue
                bucket_start = int(key // timeframe_seconds) * timeframe_seconds
                buckets.setdefault(bucket_start, {})[int(key)] = candle

            out = []
            for bucket_start in sorted(buckets):
                bucket = buckets[bucket_start]
                expected = [bucket_start + i * 60 for i in range(minute_count)]
                if any(ts not in bucket or not bucket[ts].closed for ts in expected):
                    continue
                minutes = [bucket[ts] for ts in expected]
                highs = [c.high if c.high is not None else max(c.open, c.close) for c in minutes]
                lows = [c.low if c.low is not None else min(c.open, c.close) for c in minutes]
                out.append(Candle(
                    open_time=float(bucket_start),
                    open=minutes[0].open,
                    close=minutes[-1].close,
                    closed=True,
                    high=max(highs),
                    low=min(lows),
                    volume=sum(c.volume for c in minutes),
                ))
            self._timeframe_cache[cache_key] = out

        # The cache contains only complete buckets. Slice by the decision
        # boundary without rebuilding all aggregations for every 5m window.
        cutoff = as_of_ts - timeframe_seconds
        index = bisect.bisect_right([bar.open_time for bar in out], cutoff)
        selected = out[:index]
        return selected if len(selected) >= min_bars else None

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "last_error": self.last_error,
            "last_message_age_s": (round(time.time() - self.last_message_ts, 1)
                                    if self.last_message_ts else None),
            "candles_cached": len(self.candles),
            "history_hours": round(len(self.candles) / 60, 1),
        }
