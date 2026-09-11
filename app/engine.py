"""
Trading engines -- two independent strategies sharing one capital pool.

See app/config.py for the full strategy write-up. Summary:

Engine 1 (E1): resting maker ladder at a single price (0.29) on both
sides, race-cancel, flat TP at 0.99, no stop loss (unfilled TP rides to
resolution). Dollar-sized martingale (base $10, up to 3 doublings).

Engine 2 (E2): watches for either side's mid-price to reach 0.70 first,
taker-buys that side for $30, resting TP at 0.99, taker stop loss at
0.29, forced taker close at window end if still open. Dollar-sized
martingale (base $30, up to 3 doublings).

Both engines read the SAME book each tick and both draw from / pay into
the SAME shared CapitalPool -- one balance, one halt condition, one
combined equity curve. Each engine otherwise keeps fully independent
state (its own open position, its own martingale streak).
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _midpoint(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return ask if ask is not None else bid


# ---------------------------------------------------------------------------
# Shared capital -- single balance both engines debit/credit.
# ---------------------------------------------------------------------------

@dataclass
class CapitalPool:
    balance: float
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)

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


# ---------------------------------------------------------------------------
# Engine 1 -- resting ladder @ 0.29
# ---------------------------------------------------------------------------

@dataclass
class E1PendingBuy:
    side: Side
    price: float
    shares: float


@dataclass
class E1Position:
    side: Side
    entry_price: float
    shares: float
    cost: float  # actual cash paid, post maker-rebate


@dataclass
class Engine1State:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    placed: bool = False
    pending_buys: List[E1PendingBuy] = field(default_factory=list)
    position: Optional[E1Position] = None

    martingale_level: int = 0       # 0=base, 1..MAX = doublings
    loss_streak: int = 0            # engine-lifetime, uncapped, resets on win
    max_loss_streak: int = 0        # high-water mark of loss_streak

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_fills: int = 0
    total_tp_fills: int = 0
    no_trade_windows: int = 0
    resolution_wins: int = 0
    resolution_losses: int = 0
    total_pnl: float = 0.0


class Engine1:
    name = "E1"

    def __init__(self, broker: PaperBroker, capital: CapitalPool):
        self.broker = broker
        self.capital = capital
        self.s = Engine1State()

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def _current_usd_size(self) -> float:
        return config.ENGINE1_BASE_USD * (2 ** self.s.martingale_level)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.placed = False
        self.s.pending_buys = []
        self.s.position = None
        self.s.fills_this_window = 0
        self.s.last_window_pnl = 0.0

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        self._log("WINDOW_OPEN", note=(
            f"placing ladder @ {config.ENGINE1_ENTRY_PRICE} on both sides "
            f"(size ${self._current_usd_size():.2f}, martingale level {self.s.martingale_level})"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask):
        if self.s.window is None or self.capital.halted:
            return
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask

        if not self.s.placed:
            self._place_ladder()

        self._check_buy_fills()
        self._check_sell_fill()

    # ---- entry --------------------------------------------------------

    def _place_ladder(self):
        self.s.placed = True
        price = config.ENGINE1_ENTRY_PRICE
        usd = self._current_usd_size()
        shares = usd / price
        for side in (Side.UP, Side.DOWN):
            self.s.pending_buys.append(E1PendingBuy(side=side, price=price, shares=shares))
            self._log("ORDER_PLACED", side=side.value, price=price, shares=shares,
                       note=(f"resting buy: {side.value} {shares:.2f}sh @ {price} "
                             f"(${usd:.2f}, martingale level {self.s.martingale_level}, maker, "
                             f"cancelled if opposite side fills first)"))

    def _check_buy_fills(self):
        if not self.s.pending_buys:
            return
        ordered = sorted(self.s.pending_buys, key=lambda o: o.side != Side.UP)
        for order in ordered:
            current_ask = self.s.up_ask if order.side == Side.UP else self.s.down_ask
            if current_ask is not None and current_ask <= order.price:
                self._fill_buy(order)
                for other in ordered:
                    if other is not order:
                        self._log("CANCELLED", side=other.side.value, price=other.price, shares=other.shares,
                                   note=(f"opposite-side order cancelled: {other.side.value} {other.shares:.2f}sh "
                                         f"@ {other.price} (other side filled first)"))
                self.s.pending_buys = []
                return

    def _fill_buy(self, order: E1PendingBuy):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(order.shares, order.price)
        cost = order.shares * order.price - rebate
        self.capital.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        self._log("BUY", side=order.side.value, price=order.price, shares=order.shares, fee=-rebate,
                   note=(f"ladder fill (maker): {order.side.value} {order.shares:.2f}sh @ {order.price} "
                         f"(rebate ${rebate:.4f}) -- TP set at {config.ENGINE1_TP_PRICE}"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.position = E1Position(side=order.side, entry_price=order.price, shares=order.shares, cost=cost)
        self._log("TP_PLACED", side=order.side.value, price=config.ENGINE1_TP_PRICE, shares=order.shares,
                   note=f"resting TP sell: {order.side.value} {order.shares:.2f}sh @ {config.ENGINE1_TP_PRICE}")

    # ---- exit (TP only, no stop loss) ----------------------------------

    def _check_sell_fill(self):
        pos = self.s.position
        if pos is None:
            return
        current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if current_bid is not None and current_bid >= config.ENGINE1_TP_PRICE:
            self._fill_tp(pos)

    def _fill_tp(self, pos: E1Position):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, config.ENGINE1_TP_PRICE)
        proceeds = pos.shares * config.ENGINE1_TP_PRICE + rebate
        pnl = proceeds - pos.cost

        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.total_tp_fills += 1

        self._log("TP_FILL", side=pos.side.value, price=config.ENGINE1_TP_PRICE, shares=pos.shares, pnl=pnl,
                   fee=rebate, note=(f"TP hit: {pos.side.value} {pos.shares:.2f}sh sold @ {config.ENGINE1_TP_PRICE} "
                                      f"(entry {pos.entry_price}, pnl ${pnl:.4f})"))
        self.s.position = None
        self._record_outcome(won=True)

    # ---- martingale ------------------------------------------------------

    def _record_outcome(self, won: bool):
        if won:
            self.s.loss_streak = 0
            if self.s.martingale_level != 0:
                self._log("MARTINGALE_RESET", note=f"win -- martingale reset to base (was level {self.s.martingale_level})")
            self.s.martingale_level = 0
        else:
            self.s.loss_streak += 1
            self.s.max_loss_streak = max(self.s.max_loss_streak, self.s.loss_streak)
            if self.s.martingale_level >= config.ENGINE1_MAX_MARTINGALE_LEVEL:
                self._log("MARTINGALE_RESET", note=(f"loss at max martingale level "
                           f"{config.ENGINE1_MAX_MARTINGALE_LEVEL} -- resetting to base"))
                self.s.martingale_level = 0
            else:
                self.s.martingale_level += 1
                self._log("MARTINGALE_UP", note=(f"loss -- martingale level -> {self.s.martingale_level} "
                           f"(next size ${self._current_usd_size():.2f})"))

    # ---- window close ------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        for order in self.s.pending_buys:
            self._log("EXPIRED", side=order.side.value, price=order.price, shares=order.shares,
                       note=f"unfilled ladder order expired with the window: {order.side.value} {order.shares:.2f}sh @ {order.price}")
        self.s.pending_buys = []

        if not self.capital.halted and self.s.position is not None:
            self._settle_at_resolution(self.s.position, winning_side)
            self.s.position = None

        if not self.capital.halted and self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note="ladder placed but never got hit this window -- no fills")

        self.s.window = None

    def _settle_at_resolution(self, pos: E1Position, winning_side: Optional[Side]):
        won = winning_side is not None and pos.side == winning_side
        proceeds = pos.shares * (1.0 if won else 0.0)
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        if won:
            self.s.resolution_wins += 1
        else:
            self.s.resolution_losses += 1
        event = "RESOLVE_WIN" if won else "RESOLVE_LOSS"
        self._log(event, side=pos.side.value, shares=pos.shares, pnl=pnl,
                   note=(f"TP never hit, position ({pos.side.value} {pos.shares:.2f}sh, entry {pos.entry_price}) "
                         f"settled at resolution: {'won $1/sh' if won else 'lost, $0/sh'}"))
        self._record_outcome(won=won)
        self.capital.check_halt()

    # ---- dashboard payload -------------------------------------------------

    def _mark_price(self, side: Side) -> Optional[float]:
        bid = self.s.up_bid if side == Side.UP else self.s.down_bid
        return bid

    def snapshot(self) -> dict:
        pos = self.s.position
        open_position = None
        unrealized_pnl = 0.0
        open_market_value = 0.0
        if pos is not None:
            mark = self._mark_price(pos.side)
            mark_for_calc = mark if mark is not None else pos.entry_price
            market_value = pos.shares * mark_for_calc
            unrealized_pnl = market_value - pos.cost
            open_market_value = market_value
            open_position = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": round(pos.shares, 4),
                "cost": round(pos.cost, 4), "tp_price": config.ENGINE1_TP_PRICE, "sl_price": None,
                "mark_price": mark, "unrealized_pnl": round(unrealized_pnl, 4),
            }

        return {
            "engine": "E1", "label": "Engine 1 -- Ladder @ 0.29",
            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "placed": self.s.placed,
            "open_position": open_position,
            "pending_buys": [
                {"side": o.side.value, "price": o.price, "shares": round(o.shares, 4)}
                for o in self.s.pending_buys
            ],

            "fills_this_window": self.s.fills_this_window,
            "total_fills": self.s.total_fills,
            "total_tp_fills": self.s.total_tp_fills,
            "no_trade_windows": self.s.no_trade_windows,
            "resolution_wins": self.s.resolution_wins,
            "resolution_losses": self.s.resolution_losses,

            "status": ("halted" if self.capital.halted else
                       ("open" if (self.s.pending_buys or self.s.position) else
                        ("traded" if self.s.fills_this_window > 0 else "waiting"))),

            "martingale": {
                "level": self.s.martingale_level,
                "max_level": config.ENGINE1_MAX_MARTINGALE_LEVEL,
                "base_usd": config.ENGINE1_BASE_USD,
                "current_usd": self._current_usd_size(),
                "loss_streak": self.s.loss_streak,
                "max_loss_streak": self.s.max_loss_streak,
            },

            "def": {
                "entry_price": config.ENGINE1_ENTRY_PRICE,
                "tp_price": config.ENGINE1_TP_PRICE,
                "sl_price": None,
                "base_usd": config.ENGINE1_BASE_USD,
                "max_martingale_level": config.ENGINE1_MAX_MARTINGALE_LEVEL,
            },
        }


# ---------------------------------------------------------------------------
# Engine 2 -- breakout taker entry @ 0.70, SL @ 0.29
# ---------------------------------------------------------------------------

@dataclass
class E2Position:
    side: Side
    entry_price: float
    shares: float
    cost: float


@dataclass
class Engine2State:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    triggered: bool = False
    position: Optional[E2Position] = None

    martingale_level: int = 0
    loss_streak: int = 0
    max_loss_streak: int = 0

    fills_this_window: int = 0
    last_window_pnl: float = 0.0

    total_fills: int = 0
    total_tp_fills: int = 0
    total_sl_fills: int = 0
    total_forced_closes: int = 0
    no_trade_windows: int = 0
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0


class Engine2:
    name = "E2"

    def __init__(self, broker: PaperBroker, capital: CapitalPool):
        self.broker = broker
        self.capital = capital
        self.s = Engine2State()

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    def _current_usd_size(self) -> float:
        return config.ENGINE2_BASE_USD * (2 ** self.s.martingale_level)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.triggered = False
        self.s.position = None
        self.s.fills_this_window = 0
        self.s.last_window_pnl = 0.0

        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return

        self._log("WINDOW_OPEN", note=(
            f"armed: watching for either side to reach {config.ENGINE2_TRIGGER_PRICE} "
            f"(size ${self._current_usd_size():.2f}, martingale level {self.s.martingale_level})"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask):
        if self.s.window is None or self.capital.halted:
            return
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask

        if not self.s.triggered:
            self._check_trigger()
        elif self.s.position is not None:
            self._check_sl()
            if self.s.position is not None:  # SL may have just closed it
                self._check_tp()

    # ---- entry: breakout trigger, taker buy --------------------------------

    def _check_trigger(self):
        up_mid = _midpoint(self.s.up_bid, self.s.up_ask)
        down_mid = _midpoint(self.s.down_bid, self.s.down_ask)
        trigger = config.ENGINE2_TRIGGER_PRICE
        # deterministic tie-break: UP checked first if both cross the same tick
        if up_mid is not None and up_mid >= trigger:
            self._enter(Side.UP, self.s.up_ask)
        elif down_mid is not None and down_mid >= trigger:
            self._enter(Side.DOWN, self.s.down_ask)

    def _enter(self, side: Side, ask: Optional[float]):
        if ask is None:
            return  # can't take a taker fill without a live ask
        self.s.triggered = True
        usd = self._current_usd_size()
        shares = usd / ask
        fee = self.broker.taker_fee_amount(shares, ask)
        cost = shares * ask + fee
        self.capital.balance -= cost
        self.s.fills_this_window += 1
        self.s.total_fills += 1

        self._log("BREAKOUT_BUY", side=side.value, price=ask, shares=shares, fee=fee,
                   note=(f"{side.value} mid reached {config.ENGINE2_TRIGGER_PRICE} first -- taker buy "
                         f"{shares:.2f}sh @ {ask} (${usd:.2f}, fee ${fee:.4f}) -- "
                         f"TP {config.ENGINE2_TP_PRICE}, SL {config.ENGINE2_SL_PRICE}"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.position = E2Position(side=side, entry_price=ask, shares=shares, cost=cost)

    # ---- exit: SL (taker) or TP (maker) -----------------------------------

    def _check_sl(self):
        pos = self.s.position
        current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if current_bid is not None and current_bid <= config.ENGINE2_SL_PRICE:
            self._close_taker(pos, price=current_bid, reason="SL_FILL",
                               note_prefix="stop loss hit")
            self.s.total_sl_fills += 1

    def _check_tp(self):
        pos = self.s.position
        if pos is None:
            return
        current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if current_bid is not None and current_bid >= config.ENGINE2_TP_PRICE:
            self._close_maker(pos, price=config.ENGINE2_TP_PRICE, reason="TP_FILL",
                               note_prefix="TP hit")
            self.s.total_tp_fills += 1

    def _close_maker(self, pos: E2Position, price: float, reason: str, note_prefix: str):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price + rebate
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=rebate,
                      note=f"{note_prefix} (maker): {pos.side.value} {pos.shares:.2f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, rebate ${rebate:.4f}, pnl ${pnl:.4f})")

    def _close_taker(self, pos: E2Position, price: float, reason: str, note_prefix: str):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=fee,
                      note=f"{note_prefix} (taker): {pos.side.value} {pos.shares:.2f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})")

    def _settle(self, pos: E2Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        won = pnl >= 0
        if won:
            self.s.wins += 1
        else:
            self.s.losses += 1
        self._log(reason, side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee, note=note)
        self.s.position = None
        self._record_outcome(won=won)
        self.capital.check_halt()

    # ---- martingale ------------------------------------------------------

    def _record_outcome(self, won: bool):
        if won:
            self.s.loss_streak = 0
            if self.s.martingale_level != 0:
                self._log("MARTINGALE_RESET", note=f"win -- martingale reset to base (was level {self.s.martingale_level})")
            self.s.martingale_level = 0
        else:
            self.s.loss_streak += 1
            self.s.max_loss_streak = max(self.s.max_loss_streak, self.s.loss_streak)
            if self.s.martingale_level >= config.ENGINE2_MAX_MARTINGALE_LEVEL:
                self._log("MARTINGALE_RESET", note=(f"loss at max martingale level "
                           f"{config.ENGINE2_MAX_MARTINGALE_LEVEL} -- resetting to base"))
                self.s.martingale_level = 0
            else:
                self.s.martingale_level += 1
                self._log("MARTINGALE_UP", note=(f"loss -- martingale level -> {self.s.martingale_level} "
                           f"(next size ${self._current_usd_size():.2f})"))

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return

        if not self.capital.halted and self.s.position is not None:
            pos = self.s.position
            current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
            # force a taker close at window end -- no resting-to-resolution
            # for engine 2, per spec.
            close_price = current_bid if current_bid is not None else pos.entry_price
            self._close_taker(pos, price=close_price, reason="FORCED_CLOSE",
                               note_prefix="window closed, forced taker close")
            self.s.total_forced_closes += 1

        if not self.capital.halted and self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never reached {config.ENGINE2_TRIGGER_PRICE} this window -- no trigger")

        self.s.window = None

    # ---- dashboard payload -------------------------------------------------

    def _mark_price(self, side: Side) -> Optional[float]:
        bid = self.s.up_bid if side == Side.UP else self.s.down_bid
        return bid

    def snapshot(self) -> dict:
        pos = self.s.position
        open_position = None
        unrealized_pnl = 0.0
        open_market_value = 0.0
        if pos is not None:
            mark = self._mark_price(pos.side)
            mark_for_calc = mark if mark is not None else pos.entry_price
            market_value = pos.shares * mark_for_calc
            unrealized_pnl = market_value - pos.cost
            open_market_value = market_value
            open_position = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": round(pos.shares, 4),
                "cost": round(pos.cost, 4), "tp_price": config.ENGINE2_TP_PRICE,
                "sl_price": config.ENGINE2_SL_PRICE,
                "mark_price": mark, "unrealized_pnl": round(unrealized_pnl, 4),
            }

        return {
            "engine": "E2", "label": "Engine 2 -- Breakout @ 0.70",
            "realized_pnl": round(self.s.total_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "triggered": self.s.triggered,
            "open_position": open_position,

            "fills_this_window": self.s.fills_this_window,
            "total_fills": self.s.total_fills,
            "total_tp_fills": self.s.total_tp_fills,
            "total_sl_fills": self.s.total_sl_fills,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,

            "status": ("halted" if self.capital.halted else
                       ("open" if self.s.position else
                        ("triggered" if self.s.triggered else "waiting"))),

            "martingale": {
                "level": self.s.martingale_level,
                "max_level": config.ENGINE2_MAX_MARTINGALE_LEVEL,
                "base_usd": config.ENGINE2_BASE_USD,
                "current_usd": self._current_usd_size(),
                "loss_streak": self.s.loss_streak,
                "max_loss_streak": self.s.max_loss_streak,
            },

            "def": {
                "trigger_price": config.ENGINE2_TRIGGER_PRICE,
                "tp_price": config.ENGINE2_TP_PRICE,
                "sl_price": config.ENGINE2_SL_PRICE,
                "base_usd": config.ENGINE2_BASE_USD,
                "max_martingale_level": config.ENGINE2_MAX_MARTINGALE_LEVEL,
            },
        }


# ---------------------------------------------------------------------------
# Top-level container -- owns the shared capital pool + both engines.
# ---------------------------------------------------------------------------

class Engine:
    """Drives both Engine1 and Engine2 off the same shared capital pool.
    Kept as the class name `Engine` / constructed the same way (Engine(broker))
    so app/state.py doesn't need structural changes beyond calling into the
    two sub-engines."""

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.e1 = Engine1(broker, self.capital)
        self.e2 = Engine2(broker, self.capital)
        self.capital.record_equity_point(None)

    def reset_for_window(self, window: WindowMarket):
        self.e1.reset_for_window(window)
        self.e2.reset_for_window(window)

    def on_tick(self, up_bid: Optional[float], up_ask: Optional[float],
                down_bid: Optional[float], down_ask: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        self.e1.on_tick(up_bid, up_ask, down_bid, down_ask)
        self.e2.on_tick(up_bid, up_ask, down_bid, down_ask)

    def finalize_window(self, winning_side: Optional[Side]):
        window_slug = self.e1.s.window.slug if self.e1.s.window else (
            self.e2.s.window.slug if self.e2.s.window else None)
        self.e1.finalize_window(winning_side)
        self.e2.finalize_window(winning_side)
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        e1 = self.e1.snapshot()
        e2 = self.e2.snapshot()
        realized_pnl = e1["realized_pnl"] + e2["realized_pnl"]
        unrealized_pnl = e1["unrealized_pnl"] + e2["unrealized_pnl"]
        return {
            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,

            "realized_pnl": round(realized_pnl, 4),
            "unrealized_pnl": round(unrealized_pnl, 4),
            "equity": round(self.capital.balance + e1["open_market_value"] + e2["open_market_value"], 4),

            "engines": {"e1": e1, "e2": e2},
        }
