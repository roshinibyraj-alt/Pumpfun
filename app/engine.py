"""CLOB-only execution and binary-settlement state machine.

The signal for a window is the confirmed winner of the immediately previous
5-minute window. The bot trades that same side by posting one resting limit
buy at 0.35 for the full five-minute window. There is no taker fallback.
"""
import time
from dataclasses import dataclass
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def realistic_fill_price(
    levels: Optional[list], shares: float, fallback_price: Optional[float]
) -> Optional[float]:
    """Return the depth-walked average for a complete buy, if possible."""
    if shares <= 0:
        return None
    if levels is None:
        return fallback_price
    if not levels:
        return None
    remaining = shares
    spent = 0.0
    for price, size in levels:
        if price is None or size is None or size <= 0:
            continue
        take = min(remaining, float(size))
        spent += take * float(price)
        remaining -= take
        if remaining <= 1e-9:
            return spent / shares
    return None


@dataclass
class CapitalPool:
    balance: float
    halted: bool = False

    def check_halt(self) -> bool:
        if self.balance < 0:
            self.halted = True
        return self.halted


@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    cost: float
    entry_ts: float
    entry_type: str
    fee: float = 0.0


@dataclass
class RestingOrder:
    side: Side
    shares: float
    price: float
    placed_ts: float
    active: bool = True


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    signal_side: Optional[Side] = None
    signal_status: str = "pending"
    share_size: float = 0.0
    order: Optional[RestingOrder] = None
    position: Optional[Position] = None
    entry_attempted: bool = False
    mark_price: Optional[float] = None
    last_second_up: Optional[float] = None
    last_second_down: Optional[float] = None
    last_window_pnl: float = 0.0


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(config.STARTING_CAPITAL)
        self.s = EngineState()
        self.equity_curve = []
        self.next_shares = config.BASE_SHARES
        self.last_signal_side: Optional[Side] = None
        self.history = []

        self.total_limit_orders = 0
        self.total_limit_fills = 0
        self.total_limit_cancels = 0
        self.total_taker_entries = 0
        self.total_no_trade = 0
        self.total_wins = 0
        self.total_losses = 0
        self.total_pnl = 0.0

    def _log(self, event: str, **kwargs):
        self.broker.log_event(
            self.name,
            self.s.window.slug if self.s.window else "",
            event,
            balance_after=self.capital.balance,
            **kwargs,
        )

    def reset_for_window(
        self, window: WindowMarket, previous_winner: Optional[Side], late_join: bool = False
    ):
        self.s = EngineState(window=window, share_size=self.next_shares)
        if self.capital.halted:
            self.s.signal_status = "halted"
            self._log("HALTED", note="capital halted; no new trades")
            return
        if late_join:
            self.s.signal_status = "late_join"
            self.total_no_trade += 1
            self._log("NO_TRADE", note="bot joined after window start")
            return
        if previous_winner is None:
            self.s.signal_status = "no_previous_result"
            self.total_no_trade += 1
            self._log("NO_TRADE", note="no confirmed winner from the previous window")
            return

        # A direction flip resets the progression before the new trade.
        if self.last_signal_side is not None and previous_winner != self.last_signal_side:
            self.next_shares = config.BASE_SHARES
            self.s.share_size = self.next_shares
            self._log(
                "SIZE_RESET",
                side=previous_winner.value,
                shares=self.next_shares,
                note="previous-window signal flipped direction; reset to base shares",
            )

        self.last_signal_side = previous_winner
        self.s.signal_side = previous_winner
        self.s.share_size = self.next_shares
        if self.next_shares <= 0:
            self.s.signal_status = "zero_share_skip"
            self.total_no_trade += 1
            self._log(
                "NO_TRADE",
                side=previous_winner.value,
                shares=0,
                note="same-side win progression reached the zero-share floor; waiting for a direction flip",
            )
            return

        self.s.signal_status = "armed"
        self._log(
            "WINDOW_OPEN",
            side=previous_winner.value,
            shares=self.next_shares,
            note=(
                f"previous winner {previous_winner.value}; post {self.next_shares:.0f}sh "
                f"resting limit at {config.LIMIT_ENTRY_PRICE:.2f} for the full window"
            ),
        )

    def on_tick(
        self,
        up_bid,
        up_ask,
        down_bid,
        down_ask,
        seconds_to_close: Optional[float] = None,
        now: Optional[float] = None,
        up_bid_levels: Optional[list] = None,
        up_ask_levels: Optional[list] = None,
        down_bid_levels: Optional[list] = None,
        down_ask_levels: Optional[list] = None,
    ):
        if self.s.window is None:
            return
        now = now if now is not None else time.time()
        self._mark_position(up_bid, down_bid)
        if self.capital.halted or self.s.signal_status != "armed" or self.s.position is not None:
            return
        if now >= self.s.window.close_ts:
            return

        side = self.s.signal_side
        ask = up_ask if side == Side.UP else down_ask
        ask_levels = up_ask_levels if side == Side.UP else down_ask_levels

        if self.s.order is None:
            self.s.order = RestingOrder(
                side=side,
                shares=self.s.share_size,
                price=config.LIMIT_ENTRY_PRICE,
                placed_ts=self.s.window.open_ts,
            )
            self.total_limit_orders += 1
            self._log(
                "LIMIT_PLACED",
                side=side.value,
                price=config.LIMIT_ENTRY_PRICE,
                shares=self.s.share_size,
                note="resting limit buy placed at window open",
            )

        if not self.s.order.active or ask is None:
            return
        fill = self._limit_fill_price(ask, ask_levels, self.s.order)
        if fill is not None:
            self._enter(side, self.s.order.shares, fill, now, "maker", 0.0)
            self._mark_position(up_bid, down_bid)
            self.total_limit_fills += 1
            self.s.order.active = False

    def _limit_fill_price(
        self, ask: Optional[float], levels: Optional[list], order: RestingOrder
    ) -> Optional[float]:
        if ask is None:
            return None
        if levels is None:
            return order.price if ask <= order.price else None
        eligible = [(price, size) for price, size in levels if price <= order.price]
        return realistic_fill_price(eligible, order.shares, ask) if eligible else None

    def _enter(
        self,
        side: Side,
        shares: float,
        price: float,
        now: float,
        entry_type: str,
        fee: Optional[float] = None,
    ):
        fee = self.broker.taker_fee_amount(shares, price) if fee is None else fee
        cost = shares * price + fee
        self.capital.balance -= cost
        self.s.entry_attempted = True
        self.s.position = Position(
            side=side,
            shares=shares,
            entry_price=price,
            cost=cost,
            entry_ts=now,
            entry_type=entry_type,
            fee=fee,
        )
        self._log(
            "ENTRY_FILLED",
            side=side.value,
            price=price,
            shares=shares,
            fee=fee,
            note=f"{entry_type} buy filled; binary payout is $1/share if {side.value} wins",
        )
        self.capital.check_halt()

    def _mark_position(self, up_bid, down_bid):
        """Mark an open position at the live bid, its executable exit price."""
        if self.s.position is None:
            return
        bid = up_bid if self.s.position.side == Side.UP else down_bid
        if bid is not None:
            self.s.mark_price = float(bid)

    def position_market_value(self) -> float:
        """Current liquidation value of the open position."""
        if self.s.position is None or self.s.mark_price is None:
            return 0.0
        return self.s.position.shares * self.s.mark_price

    def unrealized_pnl(self) -> float:
        """Floating P&L after including the position's entry cost and fee."""
        if self.s.position is None or self.s.mark_price is None:
            return 0.0
        return self.position_market_value() - self.s.position.cost

    def finalize_window(self, winning_side: Optional[Side]):
        """Settle an open position and resolve the signal progression.

        A signal that was armed but never filled still participates in the
        sizing progression. It has no cash or P&L impact because there was no
        position, but a win reduces the next size and a loss resets it.
        """
        if self.s.window is None:
            return
        pos = self.s.position
        signal_side = self.s.signal_side
        signal_shares = self.s.share_size
        pnl = 0.0
        result = "NO_RESULT"
        if pos is not None and winning_side is not None:
            won = pos.side == winning_side
            payout = pos.shares if won else 0.0
            self.capital.balance += payout
            pnl = payout - pos.cost
            self.total_pnl += pnl
            self.s.last_window_pnl = pnl
            if won:
                self.total_wins += 1
                self.next_shares = max(0.0, pos.shares - config.WIN_STEP_SHARES)
                result = "WIN"
            else:
                self.total_losses += 1
                self.next_shares = config.BASE_SHARES
                result = "LOSS"
            self._log(
                result,
                side=pos.side.value,
                price=1.0 if won else 0.0,
                shares=pos.shares,
                pnl=pnl,
                note=(
                    f"{'won' if won else 'lost'} binary settlement: "
                    f"{pos.shares:.0f} shares paid ${payout:.2f}; "
                    f"next base {self.next_shares:.0f} shares"
                ),
            )
        elif pos is not None:
            self._log(
                "UNRESOLVED",
                side=pos.side.value,
                shares=pos.shares,
                note="no CLOB side reached the winner threshold in the final second",
            )
            self.s.last_window_pnl = 0.0
        elif winning_side is None:
            self._log("UNRESOLVED", note="no confirmed CLOB winner for this window")
        elif signal_side is not None and self.s.signal_status == "armed":
            # The signal was eligible, but both execution filters rejected
            # the entry. Resolve the progression from the signal outcome
            # without creating a position or changing capital.
            won = signal_side == winning_side
            self.total_no_trade += 1
            self.s.last_window_pnl = 0.0
            if won:
                self.total_wins += 1
                self.next_shares = max(0.0, signal_shares - config.WIN_STEP_SHARES)
                result = "WIN_NO_TRADE"
                event = "SIGNAL_WIN_NO_TRADE"
                note = (
                    f"signalled {signal_side.value} won without a fill; "
                    f"next base {self.next_shares:.0f} shares"
                )
            else:
                self.total_losses += 1
                self.next_shares = config.BASE_SHARES
                result = "LOSS_NO_TRADE"
                event = "SIGNAL_LOSS_NO_TRADE"
                note = (
                    f"signalled {signal_side.value} lost without a fill; "
                    f"next base {self.next_shares:.0f} shares"
                )
            self._log(
                event,
                side=signal_side.value,
                shares=signal_shares,
                pnl=0.0,
                note=note,
            )
        else:
            self._log(
                "NO_TRADE",
                side=winning_side.value,
                note="window resolved without an open position",
            )

        if self.s.order is not None and self.s.order.active:
            self.s.order.active = False
            self.total_limit_cancels += 1
            self._log(
                "LIMIT_EXPIRED",
                side=self.s.order.side.value,
                price=self.s.order.price,
                shares=self.s.order.shares,
                note="resting limit expired unfilled at window close",
            )

        self.history.append(
            {
                "slug": self.s.window.slug,
                "signal_side": signal_side.value if signal_side else None,
                "winner": winning_side.value if winning_side else None,
                "shares": pos.shares if pos else signal_shares,
                "entry_price": pos.entry_price if pos else None,
                "entry_type": pos.entry_type if pos else None,
                "result": result,
                "pnl": round(pnl, 4),
                "next_shares": self.next_shares,
            }
        )
        # The position is now closed. Keeping it attached to the live state
        # after paying its settlement would double-count its value in equity.
        self.s.position = None
        self.s.mark_price = None
        self.equity_curve.append(
            {
                "ts": self.s.window.close_ts,
                "equity": round(self.equity(), 4),
                "cash_balance": round(self.capital.balance, 4),
                "realized_pnl": round(self.total_pnl, 4),
                "unrealized_pnl": 0.0,
            }
        )

    def equity(self) -> float:
        """Current portfolio equity: cash plus the live liquidation value."""
        return self.capital.balance + self.position_market_value()

    def snapshot(self) -> dict:
        pos = self.s.position
        order = self.s.order
        return {
            "engine": "CLOB_BINARY_5M",
            "label": "Previous-window winner continuation",
            "balance": round(self.capital.balance, 4),
            "cash_balance": round(self.capital.balance, 4),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity": round(self.equity(), 4),
            "equity_curve": self.equity_curve[-60:],
            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(self.unrealized_pnl(), 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),
            "signal_side": self.s.signal_side.value if self.s.signal_side else None,
            "signal_status": self.s.signal_status,
            "share_size": self.s.share_size,
            "next_shares": self.next_shares,
            "order": (
                {
                    "side": order.side.value,
                    "shares": order.shares,
                    "price": order.price,
                    "active": order.active,
                    "placed_ts": order.placed_ts,
                }
                if order
                else None
            ),
            "position": (
                {
                    "side": pos.side.value,
                    "shares": pos.shares,
                    "entry_price": pos.entry_price,
                    "cost": round(pos.cost, 4),
                    "entry_type": pos.entry_type,
                    "entry_ts": pos.entry_ts,
                    "mark_price": self.s.mark_price,
                    "market_value": round(self.position_market_value(), 4),
                    "unrealized_pnl": round(self.unrealized_pnl(), 4),
                }
                if pos
                else None
            ),
            "wins": self.total_wins,
            "losses": self.total_losses,
            "total_limit_orders": self.total_limit_orders,
            "total_limit_fills": self.total_limit_fills,
            "total_limit_cancels": self.total_limit_cancels,
            "total_taker_entries": self.total_taker_entries,
            "total_no_trade": self.total_no_trade,
            "status": self.s.signal_status,
            "def": {
                "window_seconds": config.WINDOW_SECONDS,
                "base_shares": config.BASE_SHARES,
                "win_step_shares": config.WIN_STEP_SHARES,
                "limit_entry_price": config.LIMIT_ENTRY_PRICE,
                "winner_threshold": config.WINNER_THRESHOLD,
                "binary_win_payout": 1.0,
                "binary_loss_payout": 0.0,
            },
        }