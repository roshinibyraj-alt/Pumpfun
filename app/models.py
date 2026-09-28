from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import itertools

_trade_id_counter = itertools.count(1)


class Side(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class TradeNote(str, Enum):
    BOOTSTRAP = "BOOTSTRAP"          # initial copy of a position the master already held
    LIVE_COPY = "LIVE_COPY"          # full copy of a new master trade
    PARTIAL_FILL = "PARTIAL_FILL"    # demo cash ran short, copied a smaller size than 10%
    SKIPPED = "SKIPPED"              # demo cash was zero, no shares copied at all
    CLOSE = "CLOSE"                  # a sell that fully closed our copied position


@dataclass
class CopiedPosition:
    """Our own copied holding in one outcome token. Persistent across trades."""
    token_id: str
    condition_id: str
    market_title: str
    outcome_label: str
    slug: str = ""
    icon: str = ""

    our_size: float = 0.0            # shares we (the copy bot) hold
    avg_entry_price: float = 0.0     # our own weighted-average cost per share
    cost_basis: float = 0.0          # our_size * avg_entry_price, tracked directly for accuracy

    master_size_at_last_sync: float = 0.0   # master's last-known share count in this token, for comparison

    mark_price: Optional[float] = None
    realized_pnl: float = 0.0        # cumulative realized P&L booked from partial/full sells here

    @property
    def current_value(self) -> float:
        if self.mark_price is None:
            return self.cost_basis
        return self.our_size * self.mark_price

    @property
    def unrealized_pnl(self) -> float:
        return self.current_value - self.cost_basis

    def to_dict(self):
        return {
            "token_id": self.token_id,
            "condition_id": self.condition_id,
            "market_title": self.market_title,
            "outcome_label": self.outcome_label,
            "slug": self.slug,
            "icon": self.icon,
            "our_size": round(self.our_size, 4),
            "avg_entry_price": round(self.avg_entry_price, 4),
            "cost_basis": round(self.cost_basis, 2),
            "master_size_at_last_sync": round(self.master_size_at_last_sync, 4),
            "mark_price": self.mark_price,
            "current_value": round(self.current_value, 2),
            "unrealized_pnl": round(self.unrealized_pnl, 2),
            "realized_pnl": round(self.realized_pnl, 2),
        }


@dataclass
class CopyTradeRecord:
    """One copy action taken by the bot — a demo (capped) fill, alongside the
    'ideal' uncapped figures that answer 'how much capital would this need'."""
    id: int
    timestamp: float
    token_id: str
    market_title: str
    outcome_label: str
    side: Side
    note: TradeNote

    master_trade_size: float         # shares the MASTER traded
    ideal_copy_size: float           # 10% of that, uncapped
    ideal_cost: float                # ideal_copy_size * price — "capital this signal needs"

    demo_copy_size: float            # shares actually executed in the capped demo account
    demo_cost: float                 # cash actually spent/received in the demo account
    price: float

    cash_after: float = 0.0
    realized_pnl: float = 0.0        # only non-zero on SELL rows

    def to_dict(self):
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "token_id": self.token_id,
            "market_title": self.market_title,
            "outcome_label": self.outcome_label,
            "side": self.side.value,
            "note": self.note.value,
            "master_trade_size": round(self.master_trade_size, 4),
            "ideal_copy_size": round(self.ideal_copy_size, 4),
            "ideal_cost": round(self.ideal_cost, 2),
            "demo_copy_size": round(self.demo_copy_size, 4),
            "demo_cost": round(self.demo_cost, 2),
            "price": self.price,
            "cash_after": round(self.cash_after, 2),
            "realized_pnl": round(self.realized_pnl, 2),
        }


def next_trade_id() -> int:
    return next(_trade_id_counter)
