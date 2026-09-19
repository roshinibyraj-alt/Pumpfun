"""Warm-start and walk-forward backtest for the multi-timeframe engine.

The process fetches a longer Binance history for indicator warm-up, but
evaluates only the most recent ``AI_BACKTEST_DAYS`` (one week by default).
Each historical 5-minute decision is made before its outcome is revealed;
only then is that outcome used for one learning step.
"""
import time
from typing import Optional

import httpx

from . import config
from .ai_signal import AISignalEngine
from .binance_client import BinanceKlineFeed, Candle, MAX_CANDLES

KLINES_LIMIT = 1000


async def fetch_historical_klines(days: float) -> list:
    """Fetch ascending 1-minute OHLCV rows from Binance's public REST API."""
    end_ms = int(time.time() * 1000)
    start_ms = end_ms - int(days * 86400 * 1000)
    out = []
    async with httpx.AsyncClient(timeout=20) as client:
        cursor = start_ms
        while cursor < end_ms:
            response = await client.get(config.AI_BACKTEST_BASE_URL, params={
                "symbol": "BTCUSDT",
                "interval": "1m",
                "startTime": cursor,
                "endTime": end_ms,
                "limit": KLINES_LIMIT,
            })
            response.raise_for_status()
            batch = response.json()
            if not batch:
                break
            for row in batch:
                # Never train on the currently forming Binance candle.
                if len(row) > 6 and int(row[6]) > end_ms:
                    continue
                out.append((
                    row[0] / 1000.0,
                    float(row[1]),
                    float(row[2]),
                    float(row[3]),
                    float(row[4]),
                    float(row[5]),
                ))
            cursor = batch[-1][0] + 60_000
            if len(batch) < KLINES_LIMIT:
                break
    return out


def _feed_from_klines(klines: list) -> BinanceKlineFeed:
    feed = BinanceKlineFeed()
    for row in klines:
        open_time, open_price, *rest = row
        if len(rest) >= 4:
            high, low, close, volume = rest[:4]
        else:
            # Compatibility with the old three-column tuple format.
            close = rest[0] if rest else open_price
            high, low, volume = max(open_price, close), min(open_price, close), 0.0
        key = int(open_time // 60) * 60
        feed.candles[float(key)] = Candle(
            open_time=key,
            open=float(open_price),
            close=float(close),
            closed=True,
            high=float(high),
            low=float(low),
            volume=float(volume),
        )
    return feed


def _record_bucket(bucket: dict, key: str, correct: bool):
    item = bucket.setdefault(key, {"predictions": 0, "correct": 0, "accuracy": None})
    item["predictions"] += 1
    if correct:
        item["correct"] += 1
    item["accuracy"] = round(100.0 * item["correct"] / item["predictions"], 1)


def walk_forward_backtest(ai: AISignalEngine, klines: list) -> dict:
    """Backtest the latest week and train only after each label is known."""
    if not klines:
        return {"windows": 0, "predictions": 0, "correct": 0, "accuracy": None}
    feed = _feed_from_klines(klines)
    times = sorted(feed.candles)
    first_ts, last_ts = times[0], times[-1]
    backtest_start = max(first_ts, last_ts - config.AI_BACKTEST_DAYS * 86400)
    window_seconds = config.WINDOW_SECONDS
    first_open = max(
        (int(first_ts // window_seconds) + 1) * window_seconds,
        (int(backtest_start // window_seconds) + 1) * window_seconds,
    )

    summary = {
        "period_start": backtest_start,
        "period_end": last_ts,
        "days": config.AI_BACKTEST_DAYS,
        "windows": 0,
        "predictions": 0,
        "tradeable_signals": 0,
        "correct": 0,
        "accuracy": None,
        "tradeable_accuracy": None,
        "by_regime": {},
        "by_hour_utc": {},
        "by_setup": {},
    }
    t = first_open
    while t + window_seconds <= last_ts:
        signal_open_ts = t - 60.0
        features = ai.compute_features(feed, signal_open_ts)
        open_candle = feed.get_candle(t)
        close_candle = feed.get_candle(t + window_seconds - 60)
        if features is not None and open_candle is not None and close_candle is not None:
            actual_up = close_candle.close > open_candle.open
            side, confidence = ai.predict(features)
            correct = side.value == ("UP" if actual_up else "DOWN")
            summary["windows"] += 1
            summary["predictions"] += 1
            summary["correct"] += int(correct)
            summary["accuracy"] = round(100.0 * summary["correct"] / summary["predictions"], 1)
            if ai.is_tradeable(confidence, features):
                summary["tradeable_signals"] += 1
                if correct:
                    summary.setdefault("_tradeable_correct", 0)
                    summary["_tradeable_correct"] += 1
            _record_bucket(summary["by_regime"], features.regime, correct)
            hour = time.gmtime(t).tm_hour
            _record_bucket(summary["by_hour_utc"], f"{hour:02d}:00", correct)
            setup = f"{features.regime}/{features.dominant_timeframe}"
            _record_bucket(summary["by_setup"], setup, correct)
            ai.record_prediction_result(side, actual_up)
            ai.learn(features, actual_up, pretrain=True)
        t += window_seconds

    tradeable_correct = summary.pop("_tradeable_correct", 0)
    if summary["tradeable_signals"]:
        summary["tradeable_accuracy"] = round(
            100.0 * tradeable_correct / summary["tradeable_signals"], 1
        )
    summary["period_start_iso"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(backtest_start))
    summary["period_end_iso"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_ts))
    return summary


def seed_live_feed(feed: BinanceKlineFeed, klines: list) -> int:
    """Seed enough recent OHLCV history for live multi-timeframe features."""
    if feed is None or not klines:
        return 0
    recent = klines[-MAX_CANDLES:]
    for row in recent:
        open_time, open_price, *rest = row
        if len(rest) >= 4:
            high, low, close, volume = rest[:4]
        else:
            close = rest[0] if rest else open_price
            high, low, volume = max(open_price, close), min(open_price, close), 0.0
        key = int(open_time // 60) * 60
        feed.candles[float(key)] = Candle(
            open_time=key,
            open=float(open_price),
            close=float(close),
            closed=True,
            high=float(high),
            low=float(low),
            volume=float(volume),
        )
    feed._candle_revision += 1
    feed._timeframe_cache.clear()
    feed._trim()
    return len(recent)


async def pretrain_ai(ai: AISignalEngine, live_feed: Optional[BinanceKlineFeed] = None) -> dict:
    """Fetch warm-up history, run the one-week walk-forward test, and seed live data."""
    try:
        klines = await fetch_historical_klines(config.AI_WARMUP_DAYS)
    except Exception as exc:
        return {
            "windows_trained": 0,
            "candles_seeded": 0,
            "backtest": {},
            "error": f"{type(exc).__name__}: {exc}",
        }
    try:
        summary = walk_forward_backtest(ai, klines)
        ai.set_backtest_summary(summary)
        seeded = seed_live_feed(live_feed, klines) if live_feed is not None else 0
        return {
            "windows_trained": summary.get("windows", 0),
            "candles_seeded": seeded,
            "backtest": summary,
            "error": None,
        }
    except Exception as exc:
        return {
            "windows_trained": 0,
            "candles_seeded": 0,
            "backtest": {},
            "error": f"{type(exc).__name__}: {exc}",
        }