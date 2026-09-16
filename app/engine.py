"""
Shared position model and per-engine paper ledger.

Every engine gets its own PaperLedger with its own $500 balance --
completely independent, no pooling. E1-E5 additionally run "shadow"
trades during their skip windows: identical entry/TP logic, fully
tracked through to a real win/loss result, but never touching the
engine's actual balance. Shadow trades exist purely to answer "would
this have won?" so the skip counter can be reset (win) or decremented
(not a win).
"""
import itertools
import logging
import time
from dataclasses import dataclass
from typing import Optional

from . import config, fills

_default_log = logging.getLogger("engine")
_id_counter = itertools.count(1)


@dataclass
class Position:
    id: int
    engine_label: str
    window_start: int
    asset: str
    outcome: str
    token_id: str
    opened_at: float
    shares: float
    entry_price: float
    entry_cost: float
    entry_fee: float
    is_shadow: bool = False
    status: str = "OPEN"          # OPEN | CLOSED_TP | CLOSED_SL | RESOLVED
    closed_at: Optional[float] = None
    exit_price: Optional[float] = None
    exit_proceeds: Optional[float] = None
    exit_fee: Optional[float] = None
    raw_pnl: Optional[float] = None
    resolution_won: Optional[bool] = None
    won: Optional[bool] = None


class PaperLedger:
    def __init__(self, engine_label: str, starting_capital: float, log: Optional[logging.Logger] = None):
        self.engine_label = engine_label
        self.balance = starting_capital
        self.starting_capital = starting_capital
        self.history: list = []          # real closed positions
        self.shadow_history: list = []   # shadow closed positions (transparency only)
        self.log = log or _default_log

    def open_position(self, window_start: int, outcome: str, token_id: str,
                       entry_price: float, fee_rate: float, is_shadow: bool) -> Position:
        shares = config.SHARES_PER_TRADE
        cost, fee = fills.fill_cost(entry_price, shares, fee_rate)
        pos = Position(
            id=next(_id_counter),
            engine_label=self.engine_label,
            window_start=window_start,
            asset=config.ASSET,
            outcome=outcome,
            token_id=token_id,
            opened_at=time.time(),
            shares=shares,
            entry_price=entry_price,
            entry_cost=cost,
            entry_fee=fee,
            is_shadow=is_shadow,
        )
        if not is_shadow:
            self.balance -= (cost + fee)
        self.log.info(
            "[%s] OPEN%s %s window=%s @%.2f shares=%.0f cost=%.4f fee=%.4f balance=%.2f",
            self.engine_label, " (SHADOW)" if is_shadow else "", outcome, window_start,
            entry_price, shares, cost, fee, self.balance,
        )
        return pos

    def close_take_profit(self, pos: Position) -> Position:
        """Special rule: TP pays a clean $1.00/share, no fee -- same
        treatment as a winning resolution, not a real market sale."""
        payout_price = config.TAKE_PROFIT_PAYOUT_PRICE
        proceeds = pos.shares * payout_price
        pos.status = "CLOSED_TP"
        pos.closed_at = time.time()
        pos.exit_price = payout_price
        pos.exit_proceeds = proceeds
        pos.exit_fee = 0.0
        pos.raw_pnl = proceeds - pos.entry_cost - pos.entry_fee
        pos.won = True

        if not pos.is_shadow:
            self.balance += proceeds
            self.history.append(pos)
        else:
            self.shadow_history.append(pos)
        self.log.info(
            "[%s] CLOSE_TP%s %s window=%s proceeds=%.4f pnl=%.4f balance=%.2f",
            self.engine_label, " (SHADOW)" if pos.is_shadow else "", pos.outcome,
            pos.window_start, proceeds, pos.raw_pnl, self.balance,
        )
        return pos

    def close_stop_loss_at(self, pos: Position, sl_price: float, fee_rate: float) -> Position:
        """Real stop-loss exit (E6-E9 only) -- a genuine losing sale at
        the SL price, fees apply normally."""
        proceeds, fee = fills.fill_cost(sl_price, pos.shares, fee_rate)
        pos.status = "CLOSED_SL"
        pos.closed_at = time.time()
        pos.exit_price = sl_price
        pos.exit_proceeds = proceeds
        pos.exit_fee = fee
        pos.raw_pnl = (proceeds - fee) - pos.entry_cost - pos.entry_fee
        pos.won = False

        if not pos.is_shadow:
            self.balance += (proceeds - fee)
            self.history.append(pos)
        else:
            self.shadow_history.append(pos)
        self.log.info(
            "[%s] CLOSE_SL%s %s window=%s @%.2f proceeds=%.4f pnl=%.4f balance=%.2f",
            self.engine_label, " (SHADOW)" if pos.is_shadow else "", pos.outcome,
            pos.window_start, sl_price, proceeds, pos.raw_pnl, self.balance,
        )
        return pos

    def resolve(self, pos: Position, won: bool) -> Position:
        payout = pos.shares * (1.0 if won else 0.0)
        pos.status = "RESOLVED"
        pos.closed_at = time.time()
        pos.exit_price = 1.0 if won else 0.0
        pos.exit_proceeds = payout
        pos.exit_fee = 0.0
        pos.resolution_won = won
        pos.won = won
        pos.raw_pnl = payout - pos.entry_cost - pos.entry_fee

        if not pos.is_shadow:
            self.balance += payout
            self.history.append(pos)
        else:
            self.shadow_history.append(pos)
        self.log.info(
            "[%s] RESOLVE%s %s window=%s won=%s payout=%.4f pnl=%.4f balance=%.2f",
            self.engine_label, " (SHADOW)" if pos.is_shadow else "", pos.outcome,
            pos.window_start, won, payout, pos.raw_pnl, self.balance,
        )
        return pos
