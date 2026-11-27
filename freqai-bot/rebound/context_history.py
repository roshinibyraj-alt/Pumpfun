"""Public BTC context, using completed candles only; never supplies rebound labels."""
from bisect import bisect_right
import json
import math
from pathlib import Path
import threading
import time
import urllib.parse
import urllib.request

import numpy as np

MINUTE = 60000
LOOKBACK = 480
LONG_FEATURES = [f"btc_abs_return_{n}m" for n in (1, 5, 15, 60, 240, 480)] + [
    "btc_volatility_15m", "btc_volatility_60m", "btc_volatility_480m",
    "btc_distance_median_8h", "btc_range_center_8h"]


class CandleHistory:
    def __init__(self, directory, fetch_json=None):
        self.directory = Path(directory)
        self.fetch_json = fetch_json or self._fetch
        self.lock = threading.RLock()
        self.buckets = {}
        self.last_error = None
        for name in ("public", "live"):
            file = self.directory / f"btc-context-{name}.json"
            rows = json.loads(file.read_text()) if file.exists() else []
            self.buckets[name] = {int(r[0]): r for r in rows}

    @staticmethod
    def _fetch(url):
        with urllib.request.urlopen(url, timeout=8) as response:
            return json.load(response)

    def ensure(self, start, end, bucket="live"):
        first = int(start // MINUTE) * MINUTE
        last = int(end // MINUTE) * MINUTE - MINUTE
        if last - first > 32 * 86400000:
            raise ValueError("BTC context request exceeds bounded 32-day history")
        cursor, requests = first, 0
        while cursor <= last:
            with self.lock:
                while cursor in self.buckets[bucket] and cursor <= last:
                    cursor += MINUTE
            if cursor > last:
                break
            requests += 1
            if requests > 50:
                raise ValueError("BTC history request budget exhausted")
            query = urllib.parse.urlencode({"symbol": "BTCUSDT", "interval": "1m",
                                           "startTime": cursor, "endTime": last + MINUTE - 1,
                                           "limit": 1000})
            raw = self.fetch_json("https://data-api.binance.vision/api/v3/klines?" + query)
            if not isinstance(raw, list) or not raw:
                raise ValueError("Binance returned no completed historical candles")
            rows = [[int(r[0]), float(r[4]), int(r[6])] for r in raw
                    if len(r) >= 7 and cursor <= int(r[0]) <= last
                    and int(r[0]) % MINUTE == 0 and int(r[6]) == int(r[0]) + MINUTE - 1
                    and int(r[6]) < end and math.isfinite(float(r[4])) and float(r[4]) > 0]
            if not rows or max(r[0] for r in rows) < cursor:
                raise ValueError("Binance history did not advance")
            with self.lock:
                self.buckets[bucket].update({r[0]: r for r in rows})
            cursor = max(r[0] for r in rows) + MINUTE
        with self.lock:
            limit = 50000 if bucket == "live" else 5000
            rows = sorted(self.buckets[bucket].values())[-limit:]
            self.buckets[bucket] = {r[0]: r for r in rows}
            self.directory.mkdir(parents=True, exist_ok=True)
            target = self.directory / f"btc-context-{bucket}.json"
            temporary = target.with_suffix(".tmp")
            temporary.write_text(json.dumps(rows, separators=(",", ":")))
            temporary.replace(target)
        self.last_error = None

    def vector(self, at):
        with self.lock:
            combined = {**self.buckets["public"], **self.buckets["live"]}
            rows = sorted(combined.values())
        ends = [r[2] for r in rows]
        stop = bisect_right(ends, at)
        selected = rows[max(0, stop - LOOKBACK - 1):stop]
        if len(selected) != LOOKBACK + 1:
            raise ValueError("Eight hours of prior completed BTC candles are not yet available")
        starts = np.asarray([r[0] for r in selected])
        if np.any(np.diff(starts) != MINUTE) or at - selected[-1][2] > 120000:
            raise ValueError("BTC lookback contains gaps or is stale")
        closes = np.asarray([r[1] for r in selected], dtype=float)
        returns = np.diff(np.log(closes))
        values = [abs(float(math.log(closes[-1] / closes[-1 - n])))
                  for n in (1, 5, 15, 60, 240, 480)]
        values += [float(np.std(returns[-n:])) for n in (15, 60, 480)]
        values += [abs(float(math.log(closes[-1] / np.median(closes))))]
        span = float(closes.max() - closes.min())
        position = float((closes[-1] - closes.min()) / span) if span > 0 else .5
        values += [2 * min(position, 1 - position)]
        if not np.all(np.isfinite(values)):
            raise ValueError("BTC context features are invalid")
        return values, selected[-1][2]

    def snapshot(self):
        with self.lock:
            result = {"lookbackHours": 8, "source": "Binance completed 1-minute candles",
                      "lastError": self.last_error}
            for name, bucket in self.buckets.items():
                rows = sorted(bucket.values())
                result[name] = {"candles": len(rows), "from": rows[0][0] if rows else None,
                                "through": rows[-1][2] if rows else None}
            return result

    def refresh(self):
        now = int(time.time() * 1000)
        try:
            self.ensure(now - 9 * 3600000, now)
        except Exception as error:
            self.last_error = str(error)
