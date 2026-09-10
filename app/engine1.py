"""
Engine 1 -- two-phase dual-bracket entry, step martingale, hard capital
stop.

Phase 1 (t=0s-60s): resting limit buys on BOTH sides at
ENGINE1_ENTRY_PRICE simultaneously. First to fill cancels the other.
No stop loss; TP at ENGINE1_PHASE1_TP. If neither fills by t=60s, both
orders are cancelled -- no trade from this phase.

Phase 2 (t=240s-300s), only if Phase 1 never filled: at t=240s each
side is checked independently -- still above the entry price at that
instant gets armed for the rest of the window, already at or below it
does not get armed at all. Neither side cancels the other here; up to
two independent legs can fill. Whichever fills first gets TP
ENGINE1_PHASE2_TP_FIRST, the other (if it also fills) gets
ENGINE1_PHASE2_TP_SECOND. No stop loss on either leg.

Anything still open at window close settles at Polymarket's real
resolution.

Bet sizing is a share-count step function: flat at ENGINE1_BASE_SHARES
through the first ENGINE1_MARTINGALE_TRIGGER-1 consecutive losses, then
steps up once (not compounding further) to ENGINE1_BASE_SHARES *
ENGINE1_MARTINGALE_MULT the moment the streak reaches
ENGINE1_MARTINGALE_TRIGGER, staying there until a win resets it. Each
leg settles independently the instant it closes (TP or resolution), so
a window with two Phase-2 legs can produce two separate martingale
events in whatever order they actually happen.

Capital: a real balance starting at ENGINE1_STARTING_CAPITAL: a loss
that takes it below $0 halts the engine permanently.

No stop loss means every losing leg loses (close to) its entire cost --
there is no early exit to cap damage on a bad read, which makes the
martingale ladder's tail risk considerably worse than an SL-cushioned
version. Validate in paper mode before this ever touches real money.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class OpenLeg:
    side: Side
    shares: float
    entry_price: float
    tp: float
    tag: str            # "phase1", "phase2_first", "phase2_second"
    entry_rebate: float


@dataclass
class Engine1State:
    window: Optional[WindowMarket] = None
    open_legs: List[OpenLeg] = field(default_factory=list)

    # phase 1
    phase1_filled: bool = False
    phase1_cancelled: bool = False

    # phase 2
    phase2_check_done: bool = False
    phase2_armed: Dict[Side, bool] = field(default_factory=dict)
    phase2_filled_sides: Set[Side] = field(default_factory=set)
    phase2_first_taken: bool = False

    traded_this_window: bool = False   # True the moment any leg fills

    # stats
    total_pnl: float = 0.0
    wins: int = 0
    losses: int = 0
    no_trades: int = 0
    last_window_pnl: float = 0.0
    martingale_streak: int = 0
    max_losing_streak: int = 0
    current_shares: float = 0.0

    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None

    # capital
    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)


class Engine1:
    name = "E1"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = Engine1State(current_shares=config.ENGINE1_BASE_SHARES,
                               balance=config.ENGINE1_STARTING_CAPITAL)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.open_legs = []
        self.s.phase1_filled = False
        self.s.phase1_cancelled = False
        self.s.phase2_check_done = False
        self.s.phase2_armed = {}
        self.s.phase2_filled_sides = set()
        self.s.phase2_first_taken = False
        self.s.traded_this_window = False
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
            note=(f"phase 1 (0-60s): both sides @ {config.ENGINE1_ENTRY_PRICE}, first fill "
                  f"cancels other, tp {config.ENGINE1_PHASE1_TP}, no sl; phase 2 (4-5min, "
                  f"only if phase 1 empty): re-arm sides still above entry, tp "
                  f"{config.ENGINE1_PHASE2_TP_FIRST}/{config.ENGINE1_PHASE2_TP_SECOND}; "
                  f"next size {self.s.current_shares:.0f} shares"),
            balance_after=self.s.balance,
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.s.window is None or up_price is None or down_price is None:
            return
        self.s.last_up_price = up_price
        self.s.last_down_price = down_price
        if self.s.halted:
            return
        now = now or time.time()
        elapsed = now - self.s.window.open_ts
        prices = {Side.UP: up_price, Side.DOWN: down_price}

        self._check_phase1(prices, elapsed)
        self._check_phase2_arm(prices, elapsed)
        self._check_phase2_fill(prices, elapsed)
        self._check_exits(prices)

    # ---- phase 1 ---------------------------------------------------------

    def _check_phase1(self, prices: Dict[Side, float], elapsed: float):
        if self.s.phase1_filled or self.s.phase1_cancelled:
            return
        entry = config.ENGINE1_ENTRY_PRICE
        if elapsed <= config.ENGINE1_PHASE1_END:
            up_hit = prices[Side.UP] <= entry
            down_hit = prices[Side.DOWN] <= entry
            if not up_hit and not down_hit:
                return
            if up_hit and down_hit:
                side = Side.UP if prices[Side.UP] <= prices[Side.DOWN] else Side.DOWN
            else:
                side = Side.UP if up_hit else Side.DOWN
            self._fill_leg(side, entry, config.ENGINE1_PHASE1_TP, "phase1")
            self.s.phase1_filled = True
        else:
            self.s.phase1_cancelled = True
            self.broker.log_event(
                self.name, self.s.window.slug, "CANCEL",
                note="phase 1 window closed with no fill; both resting orders cancelled",
            )

    # ---- phase 2 -----------------------------------------------------------

    def _check_phase2_arm(self, prices: Dict[Side, float], elapsed: float):
        if not self.s.phase1_cancelled or self.s.phase2_check_done:
            return
        if elapsed < config.ENGINE1_PHASE2_START:
            return
        self.s.phase2_check_done = True
        entry = config.ENGINE1_ENTRY_PRICE
        for side in (Side.UP, Side.DOWN):
            price = prices[side]
            armed = price > entry
            self.s.phase2_armed[side] = armed
            self.broker.log_event(
                self.name, self.s.window.slug, "ARMED" if armed else "PHASE2_SKIP",
                side=side.value, price=price,
                note=(f"{side.value} @ {price:.3f} {'above' if armed else 'at/below'} entry "
                      f"at 4-min check -- {'armed' if armed else 'not armed this window'}"),
            )

    def _check_phase2_fill(self, prices: Dict[Side, float], elapsed: float):
        if not self.s.phase2_check_done:
            return
        entry = config.ENGINE1_ENTRY_PRICE
        for side in (Side.UP, Side.DOWN):
            if not self.s.phase2_armed.get(side) or side in self.s.phase2_filled_sides:
                continue
            if prices[side] <= entry:
                if not self.s.phase2_first_taken:
                    tp, tag = config.ENGINE1_PHASE2_TP_FIRST, "phase2_first"
                    self.s.phase2_first_taken = True
                else:
                    tp, tag = config.ENGINE1_PHASE2_TP_SECOND, "phase2_second"
                self._fill_leg(side, entry, tp, tag)
                self.s.phase2_filled_sides.add(side)

    # ---- fills / exits -------------------------------------------------

    def _fill_leg(self, side: Side, fill_price: float, tp: float, tag: str):
        shares = self.s.current_shares
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(shares, fill_price)
        leg = OpenLeg(side=side, shares=shares, entry_price=fill_price, tp=tp,
                      tag=tag, entry_rebate=rebate)
        self.s.open_legs.append(leg)
        self.s.traded_this_window = True
        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=side.value, price=fill_price,
            shares=shares, fee=-rebate, balance_after=self.s.balance,
            note=f"{tag} entry: {side.value} @ {fill_price}, {shares:.0f} shares, tp {tp} (rebate ${rebate:.4f})",
        )

    def _check_exits(self, prices: Dict[Side, float]):
        for leg in list(self.s.open_legs):
            price = prices[leg.side]
            if price >= leg.tp:
                rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(leg.shares, price)
                proceeds = leg.shares * price
                notional = leg.shares * leg.entry_price
                pnl = proceeds - notional + rebate + leg.entry_rebate
                self._settle(leg, pnl, "tp", price, note=f"{leg.tag} take-profit")
                self.s.open_legs.remove(leg)

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.halted:
            self._record_equity_point()
            self.s.window = None
            return

        for leg in list(self.s.open_legs):
            won = winning_side is not None and leg.side == winning_side
            proceeds = leg.shares * (1.0 if won else 0.0)
            notional = leg.shares * leg.entry_price
            pnl = proceeds - notional + leg.entry_rebate
            self._settle(leg, pnl, "resolution", 1.0 if won else 0.0,
                         note=f"{leg.tag} held to resolution (no TP hit)")
        self.s.open_legs = []

        if not self.s.traded_this_window:
            self.s.no_trades += 1
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "NO_TRADE",
                balance_after=self.s.balance,
                note="no leg filled this window (phase 1 and phase 2 both empty); size unchanged",
            )

        self._record_equity_point()
        self.s.window = None

    def _record_equity_point(self):
        self.s.equity_curve.append({
            "window": self.s.window.slug if self.s.window else None,
            "ts": time.time(),
            "balance": round(self.s.balance, 2),
        })
        if len(self.s.equity_curve) > 500:
            self.s.equity_curve = self.s.equity_curve[-500:]

    def _settle(self, leg: OpenLeg, pnl: float, reason: str, exit_price: float, note: str):
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self.s.balance += pnl
        won = pnl > 0
        if won:
            self.s.wins += 1
            self.s.martingale_streak = 0
            self.s.current_shares = config.ENGINE1_BASE_SHARES
        else:
            self.s.losses += 1
            self.s.martingale_streak += 1
            self.s.max_losing_streak = max(self.s.max_losing_streak, self.s.martingale_streak)
            if self.s.martingale_streak >= config.ENGINE1_MARTINGALE_TRIGGER:
                self.s.current_shares = config.ENGINE1_BASE_SHARES * config.ENGINE1_MARTINGALE_MULT
        event = "TP_CLOSE" if reason == "tp" else ("RESOLVE_WIN" if won else "RESOLVE_LOSS")
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", event,
            side=leg.side.value, price=exit_price, shares=leg.shares, pnl=pnl,
            balance_after=self.s.balance,
            note=f"{note}; balance ${self.s.balance:.2f}; next size {self.s.current_shares:.0f} shares "
                 f"(streak {self.s.martingale_streak})",
        )

        if self.s.balance < 0:
            self.s.halted = True
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "HALTED",
                balance_after=self.s.balance,
                note=f"balance ${self.s.balance:.2f} < $0 -- bankrupt, engine stopped permanently",
            )

    # ---- reporting -------------------------------------------------------

    def _mark_price(self, side: Side) -> Optional[float]:
        return self.s.last_up_price if side == Side.UP else self.s.last_down_price

    def snapshot(self) -> dict:
        open_positions = []
        for leg in self.s.open_legs:
            mark = self._mark_price(leg.side)
            upnl = None if mark is None else leg.shares * (mark - leg.entry_price)
            open_positions.append({
                "side": leg.side.value, "shares": leg.shares, "entry_price": leg.entry_price,
                "tp": leg.tp, "tag": leg.tag, "mark_price": mark, "unrealized_pnl": upnl,
            })

        if self.s.halted:
            status = "halted"
        elif self.s.open_legs:
            status = "open"
        elif self.s.traded_this_window:
            status = "traded"
        elif self.s.phase1_cancelled and self.s.phase2_check_done:
            status = "phase2_watching"
        elif self.s.phase1_cancelled:
            status = "waiting_phase2"
        else:
            status = "phase1_watching"

        return {
            "current_shares": self.s.current_shares,
            "base_shares": config.ENGINE1_BASE_SHARES,
            "martingale_streak": self.s.martingale_streak,
            "max_losing_streak": self.s.max_losing_streak,
            "martingale_trigger": config.ENGINE1_MARTINGALE_TRIGGER,
            "total_pnl": self.s.total_pnl,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "no_trades": self.s.no_trades,
            "last_window_pnl": self.s.last_window_pnl,
            "balance": round(self.s.balance, 2),
            "starting_capital": config.ENGINE1_STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve[-100:],
            "status": status,
            "phase1_filled": self.s.phase1_filled,
            "phase1_cancelled": self.s.phase1_cancelled,
            "phase2_armed": {k.value: v for k, v in self.s.phase2_armed.items()},
            "open_positions": open_positions,
            "def": {
                "entry": config.ENGINE1_ENTRY_PRICE,
                "phase1_end": config.ENGINE1_PHASE1_END,
                "phase1_tp": config.ENGINE1_PHASE1_TP,
                "phase2_start": config.ENGINE1_PHASE2_START,
                "phase2_tp_first": config.ENGINE1_PHASE2_TP_FIRST,
                "phase2_tp_second": config.ENGINE1_PHASE2_TP_SECOND,
                "mult": config.ENGINE1_MARTINGALE_MULT,
                "trigger": config.ENGINE1_MARTINGALE_TRIGGER,
            },
        }
