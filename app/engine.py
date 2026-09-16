"""
Trading engine -- two fully independent per-side ladders (UP and DOWN),
each with a zone of buy rungs placed immediately at window open, a zone
of buy rungs placed as price shows strength, and one dynamically
universal TP at 0.99 (redeem $1.00/share, fee-free). See app/config.py for the full strategy write-up.
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a
    real order book, instead of assuming the whole size fills at the
    single best quote. Used only for the TAKER forced-close at window
    end -- every buy rung is a resting maker order that fills at its
    own exact limit price, no walk needed.

    - levels is None -> no depth data this tick; fall back to filling
      the whole size at `fallback_price`.
    - levels is [] -> book fetched fine, genuinely nothing resting on
      this side; return None, caller must not invent a fill.
    - levels is non-empty -> walk best-price-first; any shortfall in
      visible depth is priced at the worst level seen.
    """
    if levels is None:
        return fallback_price
    if not levels:
        return None
    remaining = shares
    cost = 0.0
    worst_price = levels[-1][0]
    for price, size in levels:
        if remaining <= 1e-9:
            break
        take = min(remaining, size) if size and size > 0 else 0.0
        if take <= 0:
            continue
        cost += take * price
        remaining -= take
    if remaining > 1e-9:
        cost += remaining * worst_price
    return cost / shares


# ---------------------------------------------------------------------------
# Shared capital -- single balance the engine debits/credits.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: list = field(default_factory=list)

    def record_equity_point(self, window_slug: Optional[str]):
        self.equity_curve.append({
            "window": window_slug, "ts": time.time(), "balance": round(self.balance, 2),
        })
        if len(self.equity_curve) > 500:
            self.equity_curve = self.equity_curve[-500:]

    def check_halt(self) -> bool:
        if not self.halted and self.balance < 0:
            self.halted = True
        return self.halted


@dataclass
class GridOrder:
    price: float
    shares: float
    zone: str                 # "A" or "B" -- for display/logging only
    status: str = "resting"   # resting | filled | cancelled


@dataclass

@dataclass
class SideBook:
    buy_orders: List[GridOrder] = field(default_factory=list)
    zone_b_placed: set = field(default_factory=set)   # trigger prices already fired (one-shot)
    shares_held: float = 0.0
    cost_basis: float = 0.0


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    up_book: SideBook = field(default_factory=SideBook)
    down_book: SideBook = field(default_factory=SideBook)

    total_buy_fills: int = 0
    total_forced_closes: int = 0
    total_illiquid_skips: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """Two-zone ladder with universal TP at 0.99, driven off a
    single shared capital pool. Kept as the class name `Engine` /
    constructed the same way (Engine(broker)) so app/state.py doesn't
    need structural changes."""

    name = "LADDER2"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        for side, book in ((Side.UP, self.s.up_book), (Side.DOWN, self.s.down_book)):
            for price, shares in config.ZONE_A_RUNGS:
                book.buy_orders.append(GridOrder(price=price, shares=shares, zone="A"))
            self._log("RUNG_PLACED", side=side.value,
                       note=(f"{side.value}: zone A placed at window open -- "
                             + ", ".join(f"{p}@{sh:.0f}sh" for p, sh in config.ZONE_A_RUNGS)))

        self._log("WINDOW_OPEN", note=(
            f"zone A (0.40/0.30/0.20/0.10) placed on both sides immediately, sizes 50/100/200/400. "
            f"Zone B (0.60/0.70/0.80) activates after 120s, placed as each trigger (0.70/0.80/0.90) is reached, sizes 100/200/400. "
            f"No SL. Universal TP 0.99 (redeem $1.00/share). Positions ride to TP or resolution."
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels

        self._process_side(Side.UP, now)
        self._process_side(Side.DOWN, now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _mid_for(self, side: Side) -> Optional[float]:
        return _midpoint(self._bid_for(side), self._ask_for(side))

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _book_for(self, side: Side) -> SideBook:
        return self.s.up_book if side == Side.UP else self.s.down_book

    # ---- per-tick processing for one side ----------------------------------

    def _process_side(self, side: Side, now: float):
        book = self._book_for(side)
        self._check_tp(side, book)
        self._maybe_place_zone_b(side, book, now)
        self._check_buy_fills(side, book, now)

    # ---- universal TP at 0.99 ---------------------------------------------

    def _check_tp(self, side: Side, book: SideBook):
        """If mid >= 0.99, redeem all held shares at $1.00/share (fee-free)."""
        if book.shares_held <= 0:
            return
        mid = self._mid_for(side)
        if mid is None or mid < 0.99:
            return
        proceeds = book.shares_held * 1.0   # $1.00/share, fee-free
        pnl = proceeds - book.cost_basis
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if pnl >= 0:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log("TP_HIT", side=side.value, price=1.0, shares=book.shares_held,
                  pnl=pnl, fee=0.0, note=(
            f"{side.value}: universal TP at 0.99 -- redeemed {book.shares_held:.0f}sh "
            f"at $1.00/share, pnl ${pnl:.4f}"))
        book.shares_held = 0.0
        book.cost_basis = 0.0
        self.capital.check_halt()

    # ---- zone B: one-shot trigger-based placement (active after 2min) ------

    def _maybe_place_zone_b(self, side: Side, book: SideBook, now: float):
        if now < self.s.window.open_ts + config.ZONE_B_DELAY_SECONDS:
            return
        mid = self._mid_for(side)
        if mid is None:
            return
        for trigger, order_price, shares in config.ZONE_B_RUNGS:
            if trigger in book.zone_b_placed:
                continue
            if mid >= trigger:
                book.zone_b_placed.add(trigger)
                book.buy_orders.append(GridOrder(price=order_price, shares=shares, zone="B"))
                self._log("RUNG_PLACED", side=side.value, price=order_price, shares=shares,
                           note=(f"{side.value}: {trigger} reached -- placing zone B resting buy "
                                 f"@ {order_price}, {shares:.0f}sh"))

    # ---- buy fills -----------------------------------------------------------

    def _check_buy_fills(self, side: Side, book: SideBook, now: float) -> bool:
        ask = self._ask_for(side)
        if ask is None:
            return False
        any_fill = False
        for order in book.buy_orders:
            if order.status != "resting":
                continue
            if ask <= order.price:
                order.status = "filled"
                cost = order.shares * order.price
                self.capital.balance -= cost
                book.shares_held += order.shares
                book.cost_basis += cost
                self.s.total_buy_fills += 1
                any_fill = True
                self._log("RUNG_FILL", side=side.value, price=order.price, shares=order.shares, fee=0.0,
                           note=(f"{side.value}: zone {order.zone} buy filled (maker, no fee): "
                                 f"{order.shares:.0f}sh @ {order.price} -- now holds {book.shares_held:.0f}sh, "
                                 f"cost basis ${book.cost_basis:.2f}"))
                if self.capital.check_halt():
                    self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
                    return any_fill
        return any_fill



    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            any_activity = False
            for side in (Side.UP, Side.DOWN):
                book = self._book_for(side)
                for order in book.buy_orders:
                    if order.status == "resting":
                        order.status = "cancelled"

                if book.shares_held > 0:
                    any_activity = True
                    bid = self._bid_for(side)
                    levels = self._bid_levels_for(side)
                    fill_price = _realistic_fill_price(levels, book.shares_held, bid)
                    if fill_price is None:
                        fill_price = 0.0
                        self._log("NO_LIQUIDITY", side=side.value, price=bid,
                                   note=f"{side.value}: window closed with zero bid depth -- assuming worst case $0")
                    fee = self.broker.taker_fee_amount(book.shares_held, fill_price)
                    proceeds = book.shares_held * fill_price - fee
                    pnl = proceeds - book.cost_basis
                    self.capital.balance += proceeds
                    self.s.total_pnl += pnl
                    self.s.last_window_pnl += pnl
                    self.s.total_forced_closes += 1
                    if pnl >= 0:
                        self.s.wins += 1
                    else:
                        self.s.losses += 1
                    self._log("FORCED_CLOSE", side=side.value, price=round(book.cost_basis / book.shares_held, 4),
                               shares=book.shares_held, pnl=pnl, fee=fee,
                               note=(f"{side.value}: window closed, forced taker close @ {fill_price:.4f} "
                                     f"(avg cost {book.cost_basis/book.shares_held:.4f}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                    self.capital.check_halt()
                    book.shares_held = 0.0
                    book.cost_basis = 0.0
                elif any(o.status == "filled" for o in book.buy_orders):
                    any_activity = True

            if not any_activity:
                self.s.no_trade_windows += 1
                self._log("NO_TRADE", note="neither side filled any rung this window")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _side_payload(self, side: Side) -> dict:
        book = self._book_for(side)
        bid = self._bid_for(side)
        mark = bid if bid is not None else None
        market_value = book.shares_held * mark if (mark is not None and book.shares_held > 0) else None
        unrealized = (market_value - book.cost_basis) if market_value is not None else None
        orders = [{
            "price": o.price, "shares": o.shares, "zone": o.zone, "status": o.status,
        } for o in book.buy_orders]
        return {
            "side": side.value,
            "orders": orders,
            "resting_count": sum(1 for o in book.buy_orders if o.status == "resting"),
            "filled_count": sum(1 for o in book.buy_orders if o.status == "filled"),
            "shares_held": book.shares_held,
            "cost_basis": round(book.cost_basis, 4),
            "avg_entry": round(book.cost_basis / book.shares_held, 4) if book.shares_held > 0 else None,
            "mark_price": mark,
            "market_value": round(market_value, 4) if market_value is not None else None,
            "unrealized_pnl": round(unrealized, 4) if unrealized is not None else None,
        }

    def snapshot(self) -> dict:
        up = self._side_payload(Side.UP)
        down = self._side_payload(Side.DOWN)
        open_market_value = (up["market_value"] or 0) + (down["market_value"] or 0)
        unrealized_total = (up["unrealized_pnl"] or 0) + (down["unrealized_pnl"] or 0)
        realized_pnl = round(self.s.total_pnl, 4)

        if self.capital.halted:
            status = "halted"
        elif up["shares_held"] > 0 or down["shares_held"] > 0:
            status = "open"
        else:
            status = "watching"

        return {
            "engine": "LADDER2", "label": "Two-zone ladder, universal TP 0.99",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized_total, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_book": up,
            "down_book": down,

            "total_buy_fills": self.s.total_buy_fills,
                        "total_forced_closes": self.s.total_forced_closes,
            "total_illiquid_skips": self.s.total_illiquid_skips,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "zone_a": config.ZONE_A_RUNGS,
                "zone_b": config.ZONE_B_RUNGS,
                "zone_b_delay": config.ZONE_B_DELAY_SECONDS,
                "tp_price": 0.99,
            },
        }
