"""
Trading engine -- dual-sided price-level ladder with merge-as-exit.

Entry: each tick, for BOTH UP and DOWN independently, look at the
current best ask and best bid:
  - if the best ASK sits at a price level (config.ENGINE_LEVEL_STEP
    increments, within [ENGINE_PRICE_MIN, ENGINE_PRICE_MAX]) not yet
    used this window, buy ENGINE_ORDER_SHARES there. This crosses the
    spread -- a taker fill, immediate, real taker fee applies.
  - if the best BID sits at an unused level, place a resting buy for
    ENGINE_ORDER_SHARES there instead. This is a maker order: it only
    fills on a later tick, once the market's ask trades down to (or
    through) that price. Maker fills earn the rebate, not the fee.
Either way, once a level (ask or bid) has been targeted, it's marked
used and never targeted again this window -- exactly one entry per
level, per side. Resets every window since each 5-minute window is a
brand-new market/token with a fresh book.

Exit: merging. Since exactly one of UP/DOWN pays $1 at resolution and
the other pays $0, one UP share + one DOWN share is worth a guaranteed
$1 combined at any time, via Polymarket's real merge/redeem mechanic.
Whenever both UP and DOWN inventory are simultaneously > 0, the matched
quantity is merged immediately. That's the ENTIRE exit mechanism --
there is no take-profit price and no stop loss. A merge realizes
proceeds - (UP cost basis for that qty) - (DOWN cost basis for that
qty), where cost basis already reflects fees/rebates paid at fill time.

Anything left unmatched when the window closes (inventory on only one
side, because fills on the two sides didn't land in equal size) rides
to window resolution: $1/share if that side won, $0 if it lost -- same
as every other engine in this app, no SL to cut it short.

Capital: the engine tracks the app's one and only balance, starting at
config.STARTING_CAPITAL, debited on every fill and credited on every
merge/resolution settlement. If it ever drops below $0, the engine
halts permanently -- a hard bankruptcy stop.

This is a market-making strategy: profit comes from buying UP and DOWN
cheaply enough, across enough levels, that pairs merge for more than
their combined cost (e.g. buying UP at 0.20 and DOWN at 0.75 nets
$0.05/pair before fees). It does NOT depend on correctly predicting
which side wins -- the risk is (a) never accumulating a matched pair at
all if the book gaps past levels instead of trading through them, and
(b) leftover one-sided inventory eating a full loss at resolution if
the two sides don't fill evenly. Validate thoroughly in paper mode.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _snap_to_level(price: float) -> float:
    """Round a price to the nearest tradeable grid level."""
    step = config.ENGINE_LEVEL_STEP
    return round(round(price / step) * step, 4)


def _in_range(price: Optional[float]) -> bool:
    return price is not None and config.ENGINE_PRICE_MIN <= price <= config.ENGINE_PRICE_MAX


@dataclass
class PendingOrder:
    side: Side
    price: float
    shares: float


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None

    # live book, last observed
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # running inventory per side: total shares held and total cost basis
    # (price*qty plus/minus fees/rebates already paid at fill time)
    up_shares: float = 0.0
    up_cost: float = 0.0
    down_shares: float = 0.0
    down_cost: float = 0.0

    used_levels_up: Set[float] = field(default_factory=set)
    used_levels_down: Set[float] = field(default_factory=set)
    pending_orders: List[PendingOrder] = field(default_factory=list)

    fills_this_window: int = 0
    merges_this_window: int = 0
    last_window_pnl: float = 0.0

    total_fills: int = 0
    total_merges: int = 0
    total_merged_pairs: float = 0.0
    no_trade_windows: int = 0
    resolution_wins: int = 0
    resolution_losses: int = 0
    total_pnl: float = 0.0

    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(balance=config.STARTING_CAPITAL)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.up_shares = 0.0
        self.s.up_cost = 0.0
        self.s.down_shares = 0.0
        self.s.down_cost = 0.0
        self.s.used_levels_up = set()
        self.s.used_levels_down = set()
        self.s.pending_orders = []
        self.s.fills_this_window = 0
        self.s.merges_this_window = 0
        self.s.last_window_pnl = 0.0

        if self.s.halted:
            self.broker.log_event(
                self.name, window.slug, "HALTED",
                note=f"engine halted (balance ${self.s.balance:.2f} < $0) -- no trading",
                balance_after=self.s.balance,
            )
            return

        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"ladder active on both sides, {config.ENGINE_PRICE_MIN}-{config.ENGINE_PRICE_MAX} "
                  f"@ {config.ENGINE_LEVEL_STEP} steps, {config.ENGINE_ORDER_SHARES:.0f}sh/fill, "
                  f"one entry per level; merge = exit"),
            balance_after=self.s.balance,
        )

    def on_tick(self, up_bid: Optional[float], up_ask: Optional[float],
                down_bid: Optional[float], down_ask: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.s.window is None:
            return
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        if self.s.halted:
            return

        self._check_pending_fills()
        self._check_new_entries(Side.UP, up_bid, up_ask)
        self._check_new_entries(Side.DOWN, down_bid, down_ask)
        self._try_merge()

    # ---- entries --------------------------------------------------------

    def _check_new_entries(self, side: Side, bid: Optional[float], ask: Optional[float]):
        used = self.s.used_levels_up if side == Side.UP else self.s.used_levels_down

        if _in_range(ask):
            lvl = _snap_to_level(ask)
            if lvl not in used:
                used.add(lvl)
                self._fill_ask(side, lvl)

        if _in_range(bid):
            lvl = _snap_to_level(bid)
            if lvl not in used:
                used.add(lvl)
                self._place_resting(side, lvl)

    def _fill_ask(self, side: Side, price: float):
        """Buying at the current ask crosses the spread -- an immediate
        taker fill, real taker fee applies."""
        shares = config.ENGINE_ORDER_SHARES
        fee = self.broker.taker_fee_amount(shares, price)
        cost = shares * price + fee
        self._add_inventory(side, shares, cost)
        self.s.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1
        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=side.value, price=price,
            shares=shares, fee=fee, balance_after=self.s.balance,
            note=f"ask fill (taker): {side.value} {shares:.0f}sh @ {price} (fee ${fee:.4f})",
        )
        if self.s.balance < 0:
            self._halt()

    def _place_resting(self, side: Side, price: float):
        self.s.pending_orders.append(PendingOrder(side=side, price=price, shares=config.ENGINE_ORDER_SHARES))
        self.broker.log_event(
            self.name, self.s.window.slug, "ORDER_PLACED", side=side.value, price=price,
            shares=config.ENGINE_ORDER_SHARES, balance_after=self.s.balance,
            note=f"resting bid order: {side.value} {config.ENGINE_ORDER_SHARES:.0f}sh @ {price} (maker, waiting for fill)",
        )

    def _check_pending_fills(self):
        if not self.s.pending_orders:
            return
        still_pending = []
        for order in self.s.pending_orders:
            current_ask = self.s.up_ask if order.side == Side.UP else self.s.down_ask
            if current_ask is not None and current_ask <= order.price:
                rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.price)
                cost = order.shares * order.price - rebate
                self._add_inventory(order.side, order.shares, cost)
                self.s.balance -= cost
                self.s.fills_this_window += 1
                self.s.total_fills += 1
                self.broker.log_event(
                    self.name, self.s.window.slug, "BUY", side=order.side.value, price=order.price,
                    shares=order.shares, fee=-rebate, balance_after=self.s.balance,
                    note=f"bid fill (maker): {order.side.value} {order.shares:.0f}sh @ {order.price} (rebate ${rebate:.4f})",
                )
                if self.s.balance < 0:
                    self._halt()
            else:
                still_pending.append(order)
        self.s.pending_orders = still_pending

    def _add_inventory(self, side: Side, shares: float, cost: float):
        if side == Side.UP:
            self.s.up_shares += shares
            self.s.up_cost += cost
        else:
            self.s.down_shares += shares
            self.s.down_cost += cost

    # ---- merge (the exit) ------------------------------------------------

    def _try_merge(self):
        qty = min(self.s.up_shares, self.s.down_shares)
        if qty <= 1e-9:
            return
        avg_up = self.s.up_cost / self.s.up_shares
        avg_down = self.s.down_cost / self.s.down_shares
        cost_removed_up = avg_up * qty
        cost_removed_down = avg_down * qty
        proceeds = qty * 1.0
        pnl = proceeds - cost_removed_up - cost_removed_down

        self.s.up_shares -= qty
        self.s.up_cost -= cost_removed_up
        self.s.down_shares -= qty
        self.s.down_cost -= cost_removed_down
        self.s.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.merges_this_window += 1
        self.s.total_merges += 1
        self.s.total_merged_pairs += qty

        self.broker.log_event(
            self.name, self.s.window.slug, "MERGE", shares=qty, pnl=pnl,
            balance_after=self.s.balance,
            note=(f"merged {qty:.0f} UP+DOWN pairs -> ${proceeds:.2f} redeemed, "
                  f"cost ${cost_removed_up + cost_removed_down:.4f} "
                  f"(avg UP {avg_up:.4f} + avg DOWN {avg_down:.4f})"),
        )
        if self.s.balance < 0:
            self._halt()

    def _halt(self):
        self.s.halted = True
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", "HALTED",
            balance_after=self.s.balance,
            note=f"balance ${self.s.balance:.2f} < $0 -- bankrupt, engine stopped permanently",
        )

    # ---- window close: cancel resting orders, settle any leftover -------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return

        for order in self.s.pending_orders:
            self.broker.log_event(
                self.name, self.s.window.slug, "CANCEL", side=order.side.value, price=order.price,
                shares=order.shares, balance_after=self.s.balance,
                note=f"unfilled resting order expired with the window: {order.side.value} {order.shares:.0f}sh @ {order.price}",
            )
        self.s.pending_orders = []

        if not self.s.halted:
            self._settle_leftover(Side.UP, winning_side)
            self._settle_leftover(Side.DOWN, winning_side)

            if self.s.fills_this_window == 0:
                self.s.no_trade_windows += 1
                self.broker.log_event(
                    self.name, self.s.window.slug, "NO_TRADE",
                    balance_after=self.s.balance,
                    note="no fills this window -- neither side's ask/bid ever reached the tradeable range",
                )

        self._record_equity_point()
        self.s.window = None

    def _settle_leftover(self, side: Side, winning_side: Optional[Side]):
        shares = self.s.up_shares if side == Side.UP else self.s.down_shares
        cost = self.s.up_cost if side == Side.UP else self.s.down_cost
        if shares <= 1e-9:
            return
        won = winning_side is not None and side == winning_side
        proceeds = shares * (1.0 if won else 0.0)
        pnl = proceeds - cost
        self.s.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if won:
            self.s.resolution_wins += 1
        else:
            self.s.resolution_losses += 1
        event = "RESOLVE_WIN" if won else "RESOLVE_LOSS"
        self.broker.log_event(
            self.name, self.s.window.slug, event, side=side.value, shares=shares, pnl=pnl,
            balance_after=self.s.balance,
            note=(f"leftover {side.value} inventory ({shares:.0f}sh, unmatched -- no opposite-side fill "
                  f"to merge against) settled at resolution: {'won $1/sh' if won else 'lost, $0/sh'}"),
        )
        if side == Side.UP:
            self.s.up_shares, self.s.up_cost = 0.0, 0.0
        else:
            self.s.down_shares, self.s.down_cost = 0.0, 0.0
        if self.s.balance < 0:
            self._halt()

    def _record_equity_point(self):
        self.s.equity_curve.append({
            "window": self.s.window.slug if self.s.window else None,
            "ts": time.time(),
            "balance": round(self.s.balance, 2),
        })
        if len(self.s.equity_curve) > 500:
            self.s.equity_curve = self.s.equity_curve[-500:]

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        return {
            "balance": round(self.s.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve[-150:],
            "total_pnl": self.s.total_pnl,
            "last_window_pnl": self.s.last_window_pnl,

            "up_shares": round(self.s.up_shares, 4),
            "up_avg_price": (self.s.up_cost / self.s.up_shares) if self.s.up_shares > 1e-9 else None,
            "down_shares": round(self.s.down_shares, 4),
            "down_avg_price": (self.s.down_cost / self.s.down_shares) if self.s.down_shares > 1e-9 else None,

            "pending_orders": [
                {"side": o.side.value, "price": o.price, "shares": o.shares}
                for o in self.s.pending_orders
            ],
            "used_levels_up": len(self.s.used_levels_up),
            "used_levels_down": len(self.s.used_levels_down),

            "fills_this_window": self.s.fills_this_window,
            "merges_this_window": self.s.merges_this_window,
            "total_fills": self.s.total_fills,
            "total_merges": self.s.total_merges,
            "total_merged_pairs": self.s.total_merged_pairs,
            "no_trade_windows": self.s.no_trade_windows,
            "resolution_wins": self.s.resolution_wins,
            "resolution_losses": self.s.resolution_losses,

            "status": ("halted" if self.s.halted else
                       ("open" if (self.s.up_shares > 1e-9 or self.s.down_shares > 1e-9 or self.s.pending_orders) else
                        ("traded" if self.s.fills_this_window > 0 else "waiting"))),

            "def": {
                "price_min": config.ENGINE_PRICE_MIN,
                "price_max": config.ENGINE_PRICE_MAX,
                "level_step": config.ENGINE_LEVEL_STEP,
                "order_shares": config.ENGINE_ORDER_SHARES,
            },
        }
