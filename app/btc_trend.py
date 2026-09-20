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
    completed blocks: strictly increasing block-over-block -> "up";
    strictly decreasing -> "down"; anything else (flat, mixed, a
    reversal partway through, or not enough history yet) -> None.

A gap in polling (e.g. the feed was down for a few minutes) just means
some blocks in between are silently skipped rather than fabricated --
the tracker doesn't try to backfill, so a trend read afterwards is
based on whatever's actually been observed.
"""
import math
from collections import deque
from typing import Optional


class BtcTrendTracker:
    def __init__(self, block_seconds: float, history_len: int, lookback: int):
        self.block_seconds = block_seconds
        self.lookback = lookback
        self.blocks: deque = deque(maxlen=history_len)

        self._cur_block_start: Optional[float] = None
        self._cur_sum: float = 0.0
        self._cur_count: int = 0

        self.last_price: Optional[float] = None
        self.last_sample_ts: Optional[float] = None

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
        increasing block-over-block, "down" if strictly decreasing,
        else None (flat, mixed, a reversal, or not enough history)."""
        if len(self.blocks) < self.lookback:
            return None
        recent = list(self.blocks)[-self.lookback:]
        if all(recent[i] < recent[i + 1] for i in range(len(recent) - 1)):
            return "up"
        if all(recent[i] > recent[i + 1] for i in range(len(recent) - 1)):
            return "down"
        return None

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
            "trend": self.trend(),
        }
