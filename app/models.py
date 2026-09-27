from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional
import time
import itertools

from . import config

_trade_id_counter = itertools.count(1)


class Side(str, Enum):
    UP = "UP"
    DOWN = "DOWN"


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"


class Outcome(str, Enum):
    WIN = "WIN"
    LOSS = "LOSS"
    NO_FILL = "NO_FILL"


@dataclass
class SimOrder:
    side: Side
    price: float
    size: int
    status: OrderStatus = OrderStatus.PENDING
    fill_price: Optional[float] = None
    filled_at: Optional[float] = None
    fee_usd: float = 0.0
    maker_rebate_estimate: float = 0.0

    def to_dict(self):
        return {
            "side": self.side.value,
            "price": self.price,
            "size": self.size,
            "status": self.status.value,
            "fill_price": self.fill_price,
            "fee_usd": round(self.fee_usd, 5),
            "maker_rebate_estimate": round(self.maker_rebate_estimate, 5),
        }


@dataclass
class TradeRecord:
    id: int
    window_slug: str
    strategy: str
    capital_pair: float
    rung_price: float
    outcome: Outcome
    side_filled: Optional[str]
    size: int
    cost: float
    fee_usd: float
    maker_rebate_estimate: float
    gross_pnl: float
    pnl: float
    balance_after: float
    settled_at: float

    def to_dict(self):
        return {
            "id": self.id,
            "window_slug": self.window_slug,
            "strategy": self.strategy,
            "capital_pair": self.capital_pair,
            "rung_price": self.rung_price,
            "outcome": self.outcome.value,
            "side_filled": self.side_filled,
            "size": self.size,
            "cost": round(self.cost, 2),
            "fee_usd": round(self.fee_usd, 5),
            "maker_rebate_estimate": round(self.maker_rebate_estimate, 5),
            "gross_pnl": round(self.gross_pnl, 2),
            "pnl": round(self.pnl, 2),
            "balance_after": round(self.balance_after, 2),
            "settled_at": self.settled_at,
        }


@dataclass
class CapitalPool:
    pair_price: float
    capital_start: float = config.CAPITAL_PER_PAIR
    capital_balance: float = field(default=config.CAPITAL_PER_PAIR)


@dataclass
class RungState:
    """Independent performance and sizing state backed by its paired pool.
    """
    price: float
    pair_price: float
    strategy: str
    capital_pool: CapitalPool = field(repr=False)
    current_size: int = config.BASE_SIZE
    wins: int = 0
    losses: int = 0
    no_fills: int = 0
    win_streak: int = 0
    total_gross_pnl: float = 0.0
    total_pnl: float = 0.0
    total_fees_paid: float = 0.0
    total_maker_rebate_estimate: float = 0.0
    history: list[TradeRecord] = field(default_factory=list)

    @property
    def capital_start(self) -> float:
        return self.capital_pool.capital_start

    @property
    def capital_balance(self) -> float:
        return self.capital_pool.capital_balance

    @property
    def total_trades(self) -> int:
        return self.wins + self.losses

    @property
    def win_rate(self) -> float:
        if self.total_trades == 0:
            return 0.0
        return self.wins / self.total_trades

    def record_fill_outcome(
        self,
        window_slug: str,
        side_filled: Optional[Side],
        size: int,
        outcome: Outcome,
        now: float,
        entry_price: Optional[float] = None,
        fee_usd: float = 0.0,
        maker_rebate_estimate: float = 0.0,
    ):
        cost = size * entry_price if side_filled and entry_price is not None else 0.0
        payout = 0.0
        if outcome == Outcome.WIN:
            payout = size * 1.0
            self.wins += 1
            self.win_streak += 1
            self.current_size = max(config.FLOOR_SIZE, self.current_size - config.SIZE_STEP)
        elif outcome == Outcome.LOSS:
            self.losses += 1
            self.win_streak = 0
            self.current_size = config.BASE_SIZE
        else:  # NO_FILL
            fee_usd = 0.0
            maker_rebate_estimate = 0.0
            self.no_fills += 1
            # size unchanged, streak unchanged — this rung simply didn't trade

        gross_pnl = payout - cost
        # Only realized contract P&L and charged taker fees change the shared
        # balance. The maker-rebate estimate is reported separately because
        # the real payout is market-level and pro-rata.
        pnl = gross_pnl - fee_usd
        self.capital_pool.capital_balance += pnl
        self.total_gross_pnl += gross_pnl
        self.total_pnl += pnl
        self.total_fees_paid += fee_usd
        self.total_maker_rebate_estimate += maker_rebate_estimate

        rec = TradeRecord(
            id=next(_trade_id_counter),
            window_slug=window_slug,
            strategy=self.strategy,
            capital_pair=self.pair_price,
            rung_price=self.price,
            outcome=outcome,
            side_filled=side_filled.value if side_filled else None,
            size=size,
            cost=cost,
            fee_usd=fee_usd,
            maker_rebate_estimate=maker_rebate_estimate,
            gross_pnl=gross_pnl,
            pnl=pnl,
            balance_after=self.capital_balance,
            settled_at=now,
        )
        self.history.append(rec)
        if len(self.history) > config.MAX_HISTORY:
            self.history.pop(0)
        return rec

    def to_dict(self):
        return {
            "price": self.price,
            "pair_price": self.pair_price,
            "strategy": self.strategy,
            "current_size": self.current_size,
            "next_size_if_win": max(config.FLOOR_SIZE, self.current_size - config.SIZE_STEP),
            "capital_start": self.capital_start,
            "capital_balance": round(self.capital_balance, 2),
            "wins": self.wins,
            "losses": self.losses,
            "no_fills": self.no_fills,
            "win_streak": self.win_streak,
            "total_trades": self.total_trades,
            "win_rate": round(self.win_rate * 100, 1),
            "total_gross_pnl": round(self.total_gross_pnl, 2),
            "total_pnl": round(self.total_pnl, 2),
            "total_fees_paid": round(self.total_fees_paid, 5),
            "total_maker_rebate_estimate": round(self.total_maker_rebate_estimate, 5),
        }


@dataclass
class RungOrders:
    up: SimOrder
    down: SimOrder
    filled_side: Optional[Side] = None
    settled: bool = False
    cutoff_applied: bool = False


@dataclass
class WindowState:
    slug: str
    start_ts: float
    end_ts: float
    up_token_id: str
    down_token_id: str
    strategy: Optional[str] = None
    rungs: dict = field(default_factory=dict)   # price -> RungOrders
    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None
    winner: Optional[Side] = None
    settled: bool = False
    settle_ready_at: float = 0.0
    orders_placed: bool = False

    def to_dict(self):
        rungs_out = {}
        for price, ro in self.rungs.items():
            position = None
            if ro.filled_side is not None:
                order = ro.up if ro.filled_side == Side.UP else ro.down
                mark = self.last_up_price if ro.filled_side == Side.UP else self.last_down_price
                entry = order.fill_price
                size = order.size
                unrealized = None
                mark_value = None
                if mark is not None and entry is not None:
                    unrealized = round(
                        size * (mark - entry)
                        - order.fee_usd,
                        4,
                    )
                    mark_value = round(size * mark, 2)
                position = {
                    "side": ro.filled_side.value,
                    "size": size,
                    "entry_price": entry,
                    "mark_price": mark,
                    "cost_basis": round(size * entry, 2) if entry is not None else None,
                    "fee_usd": round(order.fee_usd, 5),
                    "maker_rebate_estimate": round(order.maker_rebate_estimate, 5),
                    "mark_value": mark_value,
                    "unrealized_pnl": unrealized,
                    "settled": ro.settled,
                }
            rungs_out[f"{price:.2f}"] = {
                "up": ro.up.to_dict(),
                "down": ro.down.to_dict(),
                "filled_side": ro.filled_side.value if ro.filled_side else None,
                "settled": ro.settled,
                "position": position,
            }
        return {
            "slug": self.slug,
            "start_ts": self.start_ts,
            "end_ts": self.end_ts,
            "strategy": self.strategy,
            "last_up_price": self.last_up_price,
            "last_down_price": self.last_down_price,
            "winner": self.winner.value if self.winner else None,
            "settled": self.settled,
            "rungs": rungs_out,
        }
