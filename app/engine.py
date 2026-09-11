"""
Trading engine -- single breakout strategy.

See app/config.py for the full strategy write-up. Summary:

Breakout engine: watches for either side's mid-price to reach 0.70 first,
taker-buys that side for $30, resting TP at 0.99, taker stop loss at
0.29, forced taker close at window end if still open. Dollar-sized
anti-martingale (base $30, press up to 3 doublings on wins, any loss
resets straight back to base).
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


def sl_price_for_elapsed(elapsed: Optional[float]) -> float:
    """Time-based stop loss ladder, keyed off seconds since entry.
    config.ENGINE2_SL_SCHEDULE is a list of (elapsed_seconds, price) pairs,
    sorted ascending -- returns the price of the last step whose threshold
    has been reached. Elapsed=None (no entry timestamp available, e.g. an
    old snapshot) falls back to the base (first) step."""
    schedule = config.ENGINE2_SL_SCHEDULE
    if elapsed is None:
        return schedule[0][1]
    price = schedule[0][1]
    for threshold, step_price in schedule:
        if elapsed >= threshold:
            price = step_price
        else:
            break
    return price


def sl_step_index_for_elapsed(elapsed: Optional[float]) -> int:
    schedule = config.ENGINE2_SL_SCHEDULE
    if elapsed is None:
        return 0
    idx = 0
    for i, (threshold, _price) in enumerate(schedule):
        if elapsed >= threshold:
            idx = i
        else:
            break
    return idx


# ---------------------------------------------------------------------------
# Shared capital -- single balance the engine debits/credits.
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
# Breakout engine -- taker entry @ 0.70, SL @ 0.29, anti-martingale
# ---------------------------------------------------------------------------

@dataclass
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float = 0.0
    sl_step_index: int = 0  # last logged index into config.ENGINE2_SL_SCHEDULE


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    triggered: bool = False
    position: Optional[Position] = None

    martingale_level: int = 0
    win_streak: int = 0
    max_win_streak: int = 0

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


class Engine:
    """Breakout @ 0.70 / SL @ 0.29 / anti-martingale sizing, driven off its
    own capital pool. Kept as the class name `Engine` / constructed the
    same way (Engine(broker)) so app/state.py doesn't need structural
    changes."""

    name = "E2"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)

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
            f"(size ${self._current_usd_size():.2f}, anti-martingale press level {self.s.martingale_level})"
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask

        if not self.s.triggered:
            self._check_trigger(now)
        elif self.s.position is not None:
            self._check_sl(now)
            if self.s.position is not None:  # SL may have just closed it
                self._check_tp()

    # ---- entry: breakout trigger, taker buy --------------------------------

    def _check_trigger(self, now: float):
        up_mid = _midpoint(self.s.up_bid, self.s.up_ask)
        down_mid = _midpoint(self.s.down_bid, self.s.down_ask)
        trigger = config.ENGINE2_TRIGGER_PRICE
        # deterministic tie-break: UP checked first if both cross the same tick
        if up_mid is not None and up_mid >= trigger:
            self._enter(Side.UP, self.s.up_ask, now)
        elif down_mid is not None and down_mid >= trigger:
            self._enter(Side.DOWN, self.s.down_ask, now)

    def _enter(self, side: Side, ask: Optional[float], now: float):
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
                         f"TP {config.ENGINE2_TP_PRICE}, SL {config.ENGINE2_SL_SCHEDULE[0][1]} "
                         f"(tightens over time, see SL schedule)"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return

        self.s.position = Position(side=side, entry_price=ask, shares=shares, cost=cost, entry_ts=now)

    # ---- exit: SL (taker, time-tightened) or TP (maker) --------------------

    def _check_sl(self, now: float):
        pos = self.s.position
        elapsed = max(0.0, now - pos.entry_ts)
        step_idx = sl_step_index_for_elapsed(elapsed)
        sl_price = sl_price_for_elapsed(elapsed)

        if step_idx != pos.sl_step_index:
            pos.sl_step_index = step_idx
            self._log("SL_STEP", side=pos.side.value, price=sl_price,
                       note=(f"stop loss tightened to {sl_price} "
                             f"({int(elapsed)}s since entry)"))

        current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
        if current_bid is not None and current_bid <= sl_price:
            self._close_taker(pos, price=current_bid, reason="SL_FILL",
                               note_prefix=f"stop loss hit (tightened to {sl_price} at {int(elapsed)}s)")
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

    def _close_maker(self, pos: Position, price: float, reason: str, note_prefix: str):
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price + rebate
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=rebate,
                      note=f"{note_prefix} (maker): {pos.side.value} {pos.shares:.2f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, rebate ${rebate:.4f}, pnl ${pnl:.4f})")

    def _close_taker(self, pos: Position, price: float, reason: str, note_prefix: str):
        fee = self.broker.taker_fee_amount(pos.shares, price)
        proceeds = pos.shares * price - fee
        pnl = proceeds - pos.cost
        self._settle(pos, proceeds, pnl, reason, fee=fee,
                      note=f"{note_prefix} (taker): {pos.side.value} {pos.shares:.2f}sh sold @ {price} "
                           f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})")

    def _settle(self, pos: Position, proceeds: float, pnl: float, reason: str, fee: float, note: str):
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

    # ---- anti-martingale -----------------------------------------------------
    # A WIN presses size up (up to the level cap), and ANY loss (SL hit, or
    # a forced close that lost money) resets straight back to base. This
    # bounds the % lost on any single trade to the stop-loss distance, and
    # only ever presses size with prior winnings -- note the *dollar* size
    # of a loss still scales with whatever level you'd pressed to.

    def _record_outcome(self, won: bool):
        if won:
            self.s.win_streak += 1
            self.s.max_win_streak = max(self.s.max_win_streak, self.s.win_streak)
            if self.s.martingale_level >= config.ENGINE2_MAX_MARTINGALE_LEVEL:
                self._log("ANTI_MARTINGALE_RESET", note=(f"win completed max press level "
                           f"{config.ENGINE2_MAX_MARTINGALE_LEVEL} -- resetting to base"))
                self.s.martingale_level = 0
            else:
                self.s.martingale_level += 1
                self._log("ANTI_MARTINGALE_UP", note=(f"win -- pressing size, level -> {self.s.martingale_level} "
                           f"(next size ${self._current_usd_size():.2f})"))
        else:
            self.s.win_streak = 0
            if self.s.martingale_level != 0:
                self._log("ANTI_MARTINGALE_RESET", note=f"loss -- size reset to base (was level {self.s.martingale_level})")
            self.s.martingale_level = 0

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted and self.s.position is not None:
            pos = self.s.position
            current_bid = self.s.up_bid if pos.side == Side.UP else self.s.down_bid
            # force a taker close at window end -- no resting-to-resolution.
            close_price = current_bid if current_bid is not None else pos.entry_price
            self._close_taker(pos, price=close_price, reason="FORCED_CLOSE",
                               note_prefix="window closed, forced taker close")
            self.s.total_forced_closes += 1

        if not self.capital.halted and self.s.fills_this_window == 0:
            self.s.no_trade_windows += 1
            self._log("NO_TRADE", note=f"price never reached {config.ENGINE2_TRIGGER_PRICE} this window -- no trigger")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

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

            elapsed = max(0.0, time.time() - pos.entry_ts)
            current_sl = sl_price_for_elapsed(elapsed)
            step_idx = sl_step_index_for_elapsed(elapsed)
            schedule = config.ENGINE2_SL_SCHEDULE
            next_sl_change = None
            if step_idx + 1 < len(schedule):
                next_threshold, next_price = schedule[step_idx + 1]
                next_sl_change = {"in_seconds": round(next_threshold - elapsed, 1), "price": next_price}

            open_position = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": round(pos.shares, 4),
                "cost": round(pos.cost, 4), "tp_price": config.ENGINE2_TP_PRICE,
                "sl_price": current_sl,
                "seconds_since_entry": round(elapsed, 1),
                "next_sl_change": next_sl_change,
                "mark_price": mark, "unrealized_pnl": round(unrealized_pnl, 4),
            }

        realized_pnl = round(self.s.total_pnl, 4)

        return {
            "engine": "E2", "label": "Breakout @ 0.70",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": realized_pnl,
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
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": ("halted" if self.capital.halted else
                       ("open" if self.s.position else
                        ("triggered" if self.s.triggered else "waiting"))),

            "martingale": {
                "mode": "anti_martingale",
                "level": self.s.martingale_level,
                "max_level": config.ENGINE2_MAX_MARTINGALE_LEVEL,
                "base_usd": config.ENGINE2_BASE_USD,
                "current_usd": self._current_usd_size(),
                "win_streak": self.s.win_streak,
                "max_win_streak": self.s.max_win_streak,
            },

            "def": {
                "trigger_price": config.ENGINE2_TRIGGER_PRICE,
                "tp_price": config.ENGINE2_TP_PRICE,
                "sl_price": config.ENGINE2_SL_SCHEDULE[0][1],
                "sl_schedule": [{"after_seconds": t, "price": p} for t, p in config.ENGINE2_SL_SCHEDULE],
                "base_usd": config.ENGINE2_BASE_USD,
                "max_martingale_level": config.ENGINE2_MAX_MARTINGALE_LEVEL,
            },
        }
