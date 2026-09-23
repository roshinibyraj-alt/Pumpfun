"""CLOB-only execution and binary-settlement state machine.

Paper mode retains the regression strategy. Live mode uses one FOK market BUY
per eligible window, with dollar ladder sizing and phase-specific triggers.
"""
import time
from dataclasses import dataclass
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
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


def realistic_fill_usd(levels: Optional[list], order_usd: float, fallback_price: Optional[float], max_price: Optional[float] = None) -> Optional[tuple[float, float, float]]:
    """Return (average price, shares, notional) for a complete dollar order."""
    if order_usd <= 0:
        return None
    if levels is None:
        if fallback_price is None or fallback_price <= 0:
            return None
        if max_price is not None and fallback_price >= max_price:
            return None
        return fallback_price, order_usd / fallback_price, order_usd
    if not levels:
        return None
    remaining_usd = order_usd
    shares = 0.0
    spent = 0.0
    for price, size in levels:
        if price is None or size is None or size <= 0 or price <= 0:
            continue
        price = float(price)
        if max_price is not None and price >= max_price:
            break
        take = min(float(size), remaining_usd / price)
        shares += take
        spent += take * price
        remaining_usd -= take * price
        if remaining_usd <= 1e-9:
            return spent / shares, shares, spent
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
    order_usd: float
    shares: float
    entry_price: float
    cost: float
    entry_ts: float
    entry_type: str
    fee: float = 0.0
    maker_rebate: float = 0.0


@dataclass
class RestingOrder:
    side: Side
    order_usd: float
    shares: float
    price: float
    placed_ts: float
    active: bool = True


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    signal_side: Optional[Side] = None
    signal_status: str = "pending"
    order_usd: float = 0.0
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
        self.last_signal_side: Optional[Side] = None
        self.next_order_usd = config.BASE_ORDER_USD
        self.history = []
        self.total_limit_orders = 0
        self.total_limit_fills = 0
        self.total_limit_cancels = 0
        self.total_taker_entries = 0
        self.total_no_trade = 0
        self.total_wins = 0
        self.total_losses = 0
        self.total_pnl = 0.0
        self.total_maker_rebates = 0.0
        self.pending_maker_rebates = 0.0

    def _log(self, event: str, **kwargs):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event, balance_after=self.capital.balance, **kwargs)

    def reset_for_window(self, window: WindowMarket, previous_winner: Optional[Side], late_join: bool = False):
        self.s = EngineState(window=window, order_usd=self.next_order_usd)
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
        if self.last_signal_side is not None and previous_winner != self.last_signal_side:
            self.next_order_usd = config.BASE_ORDER_USD
            self.s.order_usd = self.next_order_usd
            self._log(
                "SIZE_RESET", side=previous_winner.value, order_usd=self.next_order_usd,
                note="signal direction flipped; reset dollar ladder to base size",
            )
        if self.next_order_usd <= 0:
            self.s.signal_status = "zero_order_skip"
            self.total_no_trade += 1
            self._log(
                "NO_TRADE", side=previous_winner.value, order_usd=0.0,
                note="same-side win progression reached the zero-dollar floor; waiting for a direction flip",
            )
            return

        self.last_signal_side = previous_winner
        self.s.signal_side = previous_winner
        self.s.signal_status = "armed"
        self._log(
            "WINDOW_OPEN", side=previous_winner.value, order_usd=self.s.order_usd,
            note=(f"previous winner {previous_winner.value}; armed for {self.s.order_usd:.2f} USD "
                  f"{'live FOK' if config.TRADING_MODE == 'live' else 'paper limit/taker'} execution"),
        )

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: Optional[float] = None, now: Optional[float] = None, up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None, down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None:
            return
        now = now if now is not None else time.time()
        self._mark_position(up_bid, down_bid)
        if self.capital.halted or self.s.signal_status != "armed" or self.s.position is not None or self.s.entry_attempted:
            return
        if now >= self.s.window.close_ts:
            return
        side = self.s.signal_side
        ask = up_ask if side == Side.UP else down_ask
        ask_levels = up_ask_levels if side == Side.UP else down_ask_levels
        elapsed = now - self.s.window.open_ts

        if self.s.order is None:
            self.s.order = RestingOrder(
                side=side, order_usd=self.s.order_usd,
                shares=self.s.order_usd / config.LIMIT_ENTRY_PRICE,
                price=config.LIMIT_ENTRY_PRICE, placed_ts=self.s.window.open_ts,
            )
            self.total_limit_orders += 1
            self._log(
                "LIMIT_PLACED", side=side.value, price=config.LIMIT_ENTRY_PRICE,
                shares=self.s.order.shares, order_usd=self.s.order.order_usd,
                note="fixed-dollar resting limit buy placed at window open",
            )

        if self.s.order.active:
            if elapsed >= config.LIMIT_ORDER_TIMEOUT_SECONDS:
                self._cancel_limit("30-second timeout from window start")
            else:
                if ask is None:
                    return
                fill = self._limit_fill_price(ask, ask_levels, self.s.order)
                if fill is not None and self._enter(side, self.s.order.order_usd, self.s.order.shares, fill, now, "maker", 0.0):
                    self._mark_position(up_bid, down_bid)
                    self.total_limit_fills += 1
                    self.s.order.active = False
                return

        # After timeout, repeat this check every poll until the ask is below 0.60.
        if elapsed < config.LIMIT_ORDER_TIMEOUT_SECONDS:
            return
        if ask is None or float(ask) >= config.TAKER_ENTRY_MAX_PRICE:
            return
        fill = realistic_fill_usd(ask_levels, self.s.order_usd, float(ask), max_price=config.TAKER_ENTRY_MAX_PRICE)
        if fill is None:
            return
        average_price, shares, notional_usd = fill
        if self._enter(side, notional_usd, shares, average_price, now, "taker"):
            self._mark_position(up_bid, down_bid)
            self.total_taker_entries += 1

    def _cancel_limit(self, note: str):
        if self.s.order is None or not self.s.order.active:
            return
        self.s.order.active = False
        self.total_limit_cancels += 1
        self._log(
            "LIMIT_CANCELED", side=self.s.order.side.value, price=self.s.order.price,
            shares=self.s.order.shares, order_usd=self.s.order.order_usd, note=note,
        )

    def _limit_fill_price(self, ask: Optional[float], levels: Optional[list], order: RestingOrder) -> Optional[float]:
        if ask is None or abs(float(ask) - order.price) > 1e-9:
            return None
        if levels is None:
            return order.price
        eligible = [(price, size) for price, size in levels if price is not None and abs(float(price) - order.price) <= 1e-9]
        fill = realistic_fill_price(eligible, order.shares, order.price) if eligible else None
        return order.price if fill is not None and abs(fill - order.price) <= 1e-9 else None

    def _enter(self, side: Side, order_usd: float, shares: float, price: float, now: float, entry_type: str, fee: Optional[float] = None) -> bool:
        fee = self.broker.taker_fee_amount(shares, price) if fee is None else fee
        maker_rebate = self.broker.maker_rebate_amount(shares, price) if entry_type == "maker" else 0.0
        notional_usd = shares * price
        cost = notional_usd + fee
        if self.capital.balance + 1e-9 < cost:
            self._log("NO_TRADE", side=side.value, price=price, shares=shares, order_usd=order_usd, fee=fee, note=f"insufficient demo capital for {cost:.5f} USD total execution cost")
            return False
        self.capital.balance -= cost
        self.pending_maker_rebates += maker_rebate
        self.s.entry_attempted = True
        self.s.position = Position(side=side, order_usd=order_usd, shares=shares, entry_price=price, cost=cost, entry_ts=now, entry_type=entry_type, fee=fee, maker_rebate=maker_rebate)
        self._log(
            "ENTRY_FILLED", side=side.value, price=price, shares=shares, order_usd=order_usd,
            fee=fee, maker_rebate=maker_rebate,
            note=(f"{entry_type} buy filled for {notional_usd:.5f} USD notional; fee {fee:.5f} USD; "
                  f"binary payout is 1 USD/share if {side.value} wins"),
        )
        self.capital.check_halt()
        return True



    def record_live_fill(self, side: Side, order_usd: float, shares: float, price: float, now: float, order_id: Optional[str] = None) -> bool:
        """Record a confirmed live FOK fill without applying local fee math."""
        if self.s.window is None or self.s.signal_status != "armed" or self.s.position is not None or self.s.entry_attempted:
            return False
        if order_usd <= 0 or shares <= 0 or price <= 0:
            return False
        notional_usd = shares * price
        # The live order has already executed at this point. Mirror its
        # notional in the local ledger so cash, equity, and realized P&L stay
        # consistent with paper mode. Live exchange fees remain external.
        self.capital.balance -= notional_usd
        self.capital.check_halt()
        self.s.entry_attempted = True
        self.s.position = Position(
            side=side, order_usd=order_usd, shares=shares, entry_price=price,
            cost=notional_usd, entry_ts=now, entry_type="live_fok", fee=0.0, maker_rebate=0.0,
        )
        self.total_taker_entries += 1
        self._log(
            "LIVE_FOK_FILLED", side=side.value, price=price, shares=shares,
            order_usd=order_usd, fee=0.0, maker_rebate=0.0,
            note=f"live Polymarket FOK BUY filled at average {price:.6f}; order {order_id or 'unknown'}; Polymarket handles fees",
        )
        return True

    def record_live_attempt(self, side: Side, order_usd: float, trigger_price: float, note: str):
        """Prevent duplicate live orders after a FOK attempt fails."""
        if self.s.window is None or self.s.entry_attempted:
            return
        self.s.entry_attempted = True
        self._log(
            "LIVE_FOK_UNFILLED", side=side.value, price=trigger_price,
            order_usd=order_usd, fee=0.0, maker_rebate=0.0, note=note,
        )

    def _mark_position(self, up_bid, down_bid):
        if self.s.position is None:
            return
        bid = up_bid if self.s.position.side == Side.UP else down_bid
        if bid is not None:
            self.s.mark_price = float(bid)

    def position_market_value(self) -> float:
        if self.s.position is None or self.s.mark_price is None:
            return 0.0
        return self.s.position.shares * self.s.mark_price

    def unrealized_pnl(self) -> float:
        if self.s.position is None or self.s.mark_price is None:
            return 0.0
        return self.position_market_value() - self.s.position.cost + self.s.position.maker_rebate

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        pos = self.s.position
        signal_side = self.s.signal_side
        pnl = 0.0
        result = "NO_RESULT"
        if pos is not None and winning_side is not None:
            won = pos.side == winning_side
            payout = pos.shares if won else 0.0
            self.capital.balance += payout + pos.maker_rebate
            self.pending_maker_rebates = max(0.0, self.pending_maker_rebates - pos.maker_rebate)
            self.total_maker_rebates += pos.maker_rebate
            pnl = payout - pos.cost + pos.maker_rebate
            self.total_pnl += pnl
            self.s.last_window_pnl = pnl
            if won:
                self.total_wins += 1
                self.next_order_usd = max(0.0, pos.order_usd - config.WIN_STEP_USD)
                result = "WIN"
            else:
                self.total_losses += 1
                self.next_order_usd = config.BASE_ORDER_USD
                result = "LOSS"
            self._log(
                result, side=pos.side.value, price=1.0 if won else 0.0,
                shares=pos.shares, order_usd=pos.order_usd, pnl=pnl,
                note=(f"{'won' if won else 'lost'} binary settlement: {pos.shares:.6f} shares paid "
                      f"{payout:.2f} USD; entry fee {pos.fee:.5f} USD; maker rebate {pos.maker_rebate:.5f} USD"),
            )
        elif pos is not None:
            self._log("UNRESOLVED", side=pos.side.value, shares=pos.shares, order_usd=pos.order_usd, note="no CLOB side reached the winner threshold in the final second")
            self.s.last_window_pnl = 0.0
        elif winning_side is None:
            self._log("UNRESOLVED", note="no confirmed CLOB winner for this window")
        elif signal_side is not None and self.s.signal_status == "armed":
            self.total_no_trade += 1
            self.s.last_window_pnl = 0.0
            won = signal_side == winning_side
            if won:
                self.total_wins += 1
                self.next_order_usd = max(0.0, self.s.order_usd - config.WIN_STEP_USD)
                result, event = "WIN_NO_TRADE", "SIGNAL_WIN_NO_TRADE"
            else:
                self.total_losses += 1
                self.next_order_usd = config.BASE_ORDER_USD
                result, event = "LOSS_NO_TRADE", "SIGNAL_LOSS_NO_TRADE"
            self._log(event, side=signal_side.value, order_usd=self.s.order_usd, pnl=0.0, note=f"signalled {signal_side.value} {'won' if won else 'lost'} without a fill; next dollar size {self.next_order_usd:.2f} USD")
        else:
            self._log("NO_TRADE", side=winning_side.value, note="window resolved without an open position")

        if self.s.order is not None and self.s.order.active:
            self._cancel_limit("window closed before the 30-second timeout")
        self.history.append({
            "slug": self.s.window.slug,
            "signal_side": signal_side.value if signal_side else None,
            "winner": winning_side.value if winning_side else None,
            "order_usd": pos.order_usd if pos else self.s.order_usd,
            "shares": pos.shares if pos else None,
            "entry_price": pos.entry_price if pos else None,
            "entry_type": pos.entry_type if pos else None,
            "result": result,
            "pnl": round(pnl, 4),
        })
        self.s.position = None
        self.s.mark_price = None
        self.equity_curve.append({
            "ts": self.s.window.close_ts,
            "equity": round(self.equity(), 4),
            "cash_balance": round(self.capital.balance, 4),
            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": 0.0,
        })

    def equity(self) -> float:
        return self.capital.balance + self.position_market_value() + self.pending_maker_rebates

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
            "pending_maker_rebate": round(self.pending_maker_rebates, 4),
            "maker_rebates": round(self.total_maker_rebates, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),
            "signal_side": self.s.signal_side.value if self.s.signal_side else None,
            "signal_status": self.s.signal_status,
            "order_usd": self.s.order_usd,
            "next_order_usd": self.next_order_usd,
            "order": ({"side": order.side.value, "order_usd": order.order_usd, "shares": order.shares, "price": order.price, "active": order.active, "placed_ts": order.placed_ts} if order else None),
            "position": ({
                "side": pos.side.value, "order_usd": pos.order_usd, "shares": pos.shares,
                "entry_price": pos.entry_price, "notional_usd": round(pos.shares * pos.entry_price, 5),
                "cost": round(pos.cost, 5), "fee": round(pos.fee, 5), "entry_type": pos.entry_type,
                "entry_ts": pos.entry_ts, "maker_rebate": round(pos.maker_rebate, 5),
                "mark_price": self.s.mark_price, "market_value": round(self.position_market_value(), 4),
                "unrealized_pnl": round(self.unrealized_pnl(), 4),
            } if pos else None),
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
                "base_order_usd": config.BASE_ORDER_USD,
                "win_step_usd": config.WIN_STEP_USD,
                "limit_entry_price": config.LIMIT_ENTRY_PRICE,
                "limit_order_timeout_seconds": config.LIMIT_ORDER_TIMEOUT_SECONDS,
                "taker_entry_max_price": config.TAKER_ENTRY_MAX_PRICE,
                "winner_threshold": config.WINNER_THRESHOLD,
                "binary_win_payout": 1.0,
                "binary_loss_payout": 0.0,
                "taker_fee_formula": "shares * 0.07 * price * (1 - price)",
                "maker_rebate_rate": config.MAKER_REBATE_RATE,
            },
        }
