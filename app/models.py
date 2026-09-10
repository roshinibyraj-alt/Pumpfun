"""Shared dataclasses / enums."""
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"

    def other(self) -> "Side":
        return Side.DOWN if self == Side.UP else Side.UP


@dataclass
class PricePoint:
    ts: float
    up: Optional[float]
    down: Optional[float]


@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    fee: float = 0.0
    opened_at: float = field(default_factory=time.time)

    @property
    def notional(self) -> float:
        """Raw shares * price, before fees."""
        return self.shares * self.entry_price

    @property
    def cost(self) -> float:
        """Total cost basis including the entry taker fee."""
        return self.notional + self.fee


@dataclass
class TradeLogEntry:
    ts: float
    engine: str          # "A" or "B"
    window_slug: str
    event: str            # human readable event name
    side: Optional[str] = None
    price: Optional[float] = None
    shares: Optional[float] = None
    fee: Optional[float] = None
    pnl: Optional[float] = None
    balance_after: Optional[float] = None
    note: Optional[str] = None


@dataclass
class WindowMarket:
    slug: str
    condition_id: Optional[str]
    token_up: Optional[str]
    token_down: Optional[str]
    open_ts: float
    close_ts: float
