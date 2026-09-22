"""Paper-trading ledger and Polymarket fee/rebate calculators."""
import time
from typing import List, Optional

from . import config
from .log_tracker import LogTracker
from .models import TradeLogEntry


class PaperBroker:
    def __init__(self, tracker: Optional[LogTracker] = None):
        self.log: List[TradeLogEntry] = []
        self.tracker = tracker or LogTracker()

    def _push_log(self, entry: TradeLogEntry):
        self.log.append(entry)
        if len(self.log) > config.LOG_MAX_ENTRIES:
            self.log.pop(0)

    def taker_fee_amount(self, shares: float, price: float) -> float:
        """Return the Polymarket Crypto taker fee, rounded to 5 decimals."""
        if not config.APPLY_TAKER_FEES or shares <= 0 or price < 0 or price > 1:
            return 0.0
        fee = shares * config.TAKER_FEE_RATE * price * (1 - price) ** config.TAKER_FEE_EXPONENT
        return round(fee, 5)

    def maker_rebate_amount(self, shares: float, price: float) -> float:
        """Estimate the daily maker rebate for a filled maker order."""
        if shares <= 0 or price < 0 or price > 1:
            return 0.0
        fee_equivalent = shares * config.TAKER_FEE_RATE * price * (1 - price) ** config.TAKER_FEE_EXPONENT
        return round(fee_equivalent * config.MAKER_REBATE_RATE, 5)

    def log_event(
        self, engine: str, window_slug: str, event: str, note: str = "",
        side: Optional[str] = None, price: Optional[float] = None,
        shares: Optional[float] = None, order_usd: Optional[float] = None,
        fee: Optional[float] = None, maker_rebate: Optional[float] = None,
        pnl: Optional[float] = None, balance_after: Optional[float] = None,
    ):
        self._push_log(TradeLogEntry(
            ts=time.time(), engine=engine, window_slug=window_slug, event=event,
            side=side, price=price, shares=shares, order_usd=order_usd,
            fee=fee, maker_rebate=maker_rebate, pnl=pnl,
            balance_after=balance_after, note=note,
        ))
        self.tracker.record(self.log[-1])
