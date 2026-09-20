"""
Rolling BTC spot-price trend tracker.

Independent of the Polymarket window clock -- this just watches BTC/USD
spot price over time and answers one question: has it been cleanly
trending up or down lately?

Mechanics:
  - Samples are fed in via update(price, now) whenever the caller polls
    the spot price feed (see PolymarketClient.fetch_btc_spot_price()).
  - Samples are bucketed into fixed BTC_BLOCK_SECONDS (30s) wall-clock
    blocks (floor(now / block_seconds) * block_seconds), and each
    block's value is the average of every sample that landed in it.
  - A rolling deque of the last BTC_TREND_HISTORY_BLOCKS completed
    blocks is kept (the in-progress block is never part of this deque
    until it closes).
  - trend() looks at the most recent BTC_TREND_LOOKBACK_BLOCKS
    completed blocks. BTC realistically only moves in ~$1 increments
    over a 30s block, so a sub-$1 wobble between two blocks isn't a
    real move -- it's noise/rounding. Each block-over-block step must
    be at least MIN_STEP (in dollars) in the same direction: strictly
    increasing by >= MIN_STEP every step -> "up"; strictly decreasing
    by >= MIN_STEP every step -> "down"; anything else (flat, mixed, a
    reversal, a sub-$1 step, or not enough history yet) -> None.
  - effective_trend() is trend() plus carryover: if the fresh read is
    None, it returns whatever the last clear "up"/"down" read was, so
    a momentary flat/mixed patch doesn't erase a trend that was just
    established -- it only updates once a new clear trend (same or
    opposite direction) is read. Returns None if no clear trend has
    ever been read yet (e.g. still warming up on startup).

A gap in polling (e.g. the feed was down for a few minutes) just means
some blocks in between are silently skipped rather than fabricated --
the tracker doesn't try to backfill, so a trend read afterwards is
based on whatever's actually been observed.
"""
import math
from collections import deque
from typing import Optional

DEFAULT_MIN_STEP = 1.0   # dollars -- fallback if the caller doesn't pass one; see
                          # config.BTC_TREND_MIN_STEP_USD for the value actually used


class BtcTrendTracker:
    def __init__(self, block_seconds: float, history_len: int, lookback: int,
                 min_step: float = DEFAULT_MIN_STEP):
        self.block_seconds = block_seconds
        self.lookback = lookback
        self.min_step = min_step   # minimum $ move between consecutive blocks to count as a
                                    # real step, not sub-$1 noise/rounding
        self.blocks: deque = deque(maxlen=history_len)

        self._cur_block_start: Optional[float] = None
        self._cur_sum: float = 0.0
        self._cur_count: int = 0

        self.last_price: Optional[float] = None
        self.last_sample_ts: Optional[float] = None

        # Last clear ("up"/"down") trend() read, carried forward whenever
        # a fresh read comes back None -- see effective_trend().
        self._last_clear_trend: Optional[str] = None

    def _block_start_for(self, ts: float) -> float:
        return math.floor(ts / self.block_seconds) * self.block_seconds

    def update(self, price: Optional[float], now: float):
        """Feed in one BTC spot-price sample. No-ops if price is None
        (a failed fetch) -- the caller should just try again next poll."""
        if price is None:
            return
        self.last_price = price
        self.last_sample_ts = now

        block_start = self._block_start_for(now)
        if self._cur_block_start is None:
            self._cur_block_start = block_start
        elif block_start != self._cur_block_start:
            # The wall-clock block has rolled over -- close out whatever
            # samples landed in the previous block (if any) and start fresh.
            # If polling was gappy and we jumped forward by more than one
            # block, the blocks in between are simply never recorded --
            # no interpolation, no fabricated data.
            if self._cur_count > 0:
                self.blocks.append(self._cur_sum / self._cur_count)
            self._cur_block_start = block_start
            self._cur_sum = 0.0
            self._cur_count = 0

        self._cur_sum += price
        self._cur_count += 1

    def trend(self) -> Optional[str]:
        """"up" if the last `lookback` completed blocks are strictly
        increasing block-over-block by at least self.min_step each
        step, "down" if strictly decreasing by at least self.min_step
        each step, else None (flat, mixed, a reversal, a sub-min_step
        step, or not enough history). Updates the carryover value used
        by effective_trend() as a side effect."""
        if len(self.blocks) < self.lookback:
            return None
        recent = list(self.blocks)[-self.lookback:]
        result: Optional[str] = None
        if all(recent[i + 1] - recent[i] >= self.min_step for i in range(len(recent) - 1)):
            result = "up"
        elif all(recent[i] - recent[i + 1] >= self.min_step for i in range(len(recent) - 1)):
            result = "down"
        if result is not None:
            self._last_clear_trend = result
        return result

    def effective_trend(self) -> Optional[str]:
        """trend() with carryover: if the fresh read is None, fall back
        to the last clear "up"/"down" read (from any previous call to
        trend()) instead of losing the signal to a momentary flat/mixed
        patch. None only if no clear trend has ever been read."""
        fresh = self.trend()
        if fresh is not None:
            return fresh
        return self._last_clear_trend

    def snapshot(self) -> dict:
        """Dashboard payload -- completed block history, the in-progress
        block's running average (if any samples have landed in it yet),
        and the current trend read."""
        in_progress_avg = (self._cur_sum / self._cur_count) if self._cur_count > 0 else None
        return {
            "last_price": self.last_price,
            "last_sample_ts": self.last_sample_ts,
            "blocks": [round(b, 2) for b in self.blocks],
            "in_progress_block_avg": round(in_progress_avg, 2) if in_progress_avg is not None else None,
            "in_progress_block_samples": self._cur_count,
            "lookback": self.lookback,
            "history_len": self.blocks.maxlen,
            "block_seconds": self.block_seconds,
            "min_step": self.min_step,
            "trend": self.trend(),
            "effective_trend": self.effective_trend(),
        }
