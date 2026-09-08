"""
Trading engine -- streak-filtered single-side entry, martingale, hard
capital stop. No stop loss: every open position rides to take-profit or
Polymarket's real resolution.

Entry filter: at window open, a resting limit buy is placed at
ENGINE_ENTRY_PRICE on ONLY the side that won the PREVIOUS window (real
resolution, not this engine's own trade outcome). If that side has won
ENGINE_STREAK_FILTER_LENGTH windows in a row, the engine places no order
at all and sits out until a window resolves with the opposite side
winning -- that flip starts a new streak (count 1) and trading resumes
on it the following window. The very first window ever has no prior
result, so it's sat out too.

Exit: TP via a limit sell, or Polymarket's real resolution if TP isn't
hit by window close. There is no stop loss -- a losing trade always
rides all the way to resolution ($0/share if it loses), rather than
being cut early at a partial loss. That makes each loss more expensive
than it would be with an SL, though it doesn't change how often a side
wins.

Bet sizing is a martingale ladder: a loss (resolution loss) multiplies
the next TRADED window's bet by ENGINE_MARTINGALE_MULT; a win resets it
to ENGINE_BASE_BET. Windows with no trade -- whether from the streak
filter or because price never reached the entry price -- never move the
ladder.

Capital: the engine tracks the app's one and only balance, starting at
config.STARTING_CAPITAL. This is what the dashboard's "Demo Capital"
figure shows. If a loss ever takes it below $0, the engine halts
permanently (no further entries) -- a hard bankruptcy stop.

This entry filter changes WHICH windows get traded; it does not change
the market's underlying odds on any individual trade, and the engine's
own win/loss outcome is a different thing from which side wins the
market each window. If 5-minute BTC windows are close to independent,
this filter may not meaningfully reduce real losing-streak risk -- the
martingale ladder itself (made steeper here by the lack of an SL)
remains the dominant source of tail risk. Validate in paper mode before
this ever touches real money.
"""
import time
from dataclasses import dataclass, field
from typing import List, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    traded: bool = False
    position: Optional[Position] = None
    exit_reason: Optional[str] = None
    entry_rebate: float = 0.0
    current_bet: float = 0.0
    total_pnl: float = 0.0
    wins: int = 0
    losses: int = 0
    no_trades: int = 0
    last_window_pnl: float = 0.0
    martingale_streak: int = 0       # consecutive losses feeding the current bet size
    max_losing_streak: int = 0       # all-time high watermark of the above
    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None

    # streak filter
    streak_side: Optional[Side] = None     # side currently on a same-side win streak
    streak_count: int = 0                  # how many windows in a row it's won
    trade_side_this_window: Optional[Side] = None  # None = sit out this window
    skip_reason: Optional[str] = None      # why trade_side_this_window is None, for logging

    # capital
    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)  # [{window, balance}, ...]


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(current_bet=config.ENGINE_BASE_BET,
                              balance=config.STARTING_CAPITAL,
                              trade_side_this_window=None,
                              skip_reason="no prior window result yet")

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.traded = False
        self.s.position = None
        self.s.exit_reason = None
        self.s.entry_rebate = 0.0
        self.s.last_window_pnl = 0.0

        if self.s.halted:
            self.broker.log_event(
                self.name, window.slug, "HALTED",
                note=f"engine halted (balance ${self.s.balance:.2f} < $0) -- no trading",
                balance_after=self.s.balance,
            )
            return

        if self.s.trade_side_this_window is None:
            self.broker.log_event(
                self.name, window.slug, "WINDOW_OPEN",
                note=f"sitting out this window ({self.s.skip_reason}); next bet ${self.s.current_bet:.2f}",
                balance_after=self.s.balance,
            )
        else:
            side = self.s.trade_side_this_window
            self.broker.log_event(
                self.name, window.slug, "WINDOW_OPEN",
                side=side.value,
                note=(f"resting buy on {side.value} only @ {config.ENGINE_ENTRY_PRICE} "
                      f"(streak: {side.value} has won {self.s.streak_count} in a row), "
                      f"tp {config.ENGINE_TP}, no SL -- rides to resolution otherwise, "
                      f"next bet ${self.s.current_bet:.2f}"),
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
        if not self.s.traded:
            self._check_entry(up_price, down_price)
        elif self.s.position is not None:
            self._check_exit(up_price, down_price)

    def _check_entry(self, up_price: float, down_price: float):
        side = self.s.trade_side_this_window
        if side is None:
            return  # sitting out this window (streak filter or no prior result)
        entry = config.ENGINE_ENTRY_PRICE
        price = up_price if side == Side.UP else down_price
        if price <= entry:
            self._fill_entry(side, entry)

    def _fill_entry(self, side: Side, fill_price: float):
        bet = self.s.current_bet
        shares = bet / fill_price
        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(shares, fill_price)
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, fee=0.0)
        self.s.entry_rebate = rebate
        self.s.traded = True
        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=side.value, price=fill_price,
            shares=shares, fee=-rebate, balance_after=self.s.balance,
            note=f"single-side entry: {side.value} @ {fill_price}, bet ${bet:.2f} (rebate ${rebate:.4f})",
        )

    def _check_exit(self, up_price: float, down_price: float):
        pos = self.s.position
        price = up_price if pos.side == Side.UP else down_price
        if price >= config.ENGINE_TP:
            rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, price)
            self._close(price, "tp", fee=0.0, rebate=rebate)

    def _close(self, price: float, reason: str, fee: float, rebate: float):
        pos = self.s.position
        proceeds = pos.shares * price
        pnl = proceeds - pos.notional - fee + rebate + self.s.entry_rebate
        self._settle(pos, pnl, reason, price, fee, rebate, note="take-profit")

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.halted:
            self._record_equity_point()
            self._update_streak_filter(winning_side)
            self.s.window = None
            return

        if self.s.position is not None:
            pos = self.s.position
            won = winning_side is not None and pos.side == winning_side
            proceeds = pos.shares * (1.0 if won else 0.0)
            pnl = proceeds - pos.notional + self.s.entry_rebate
            self._settle(pos, pnl, "resolution", 1.0 if won else 0.0, 0.0, 0.0,
                         note="held to resolution (no TP hit, no SL to cut it early)")
        elif not self.s.traded:
            self.s.no_trades += 1
            reason = "streak filter" if self.s.trade_side_this_window is None and self.s.window is not None else "price never reached entry"
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "NO_TRADE",
                balance_after=self.s.balance,
                note=f"no trade this window ({reason}); bet size unchanged",
            )

        self._record_equity_point()
        self._update_streak_filter(winning_side)
        self.s.window = None

    def _update_streak_filter(self, winning_side: Optional[Side]):
        if winning_side is None:
            # Couldn't confirm the real outcome -- stay cautious, sit out
            # next window rather than guess.
            self.s.trade_side_this_window = None
            self.s.skip_reason = "previous window's outcome could not be confirmed"
            return

        if self.s.streak_side is None or winning_side != self.s.streak_side:
            self.s.streak_side = winning_side
            self.s.streak_count = 1
        else:
            self.s.streak_count += 1

        if self.s.streak_count >= config.ENGINE_STREAK_FILTER_LENGTH:
            self.s.trade_side_this_window = None
            self.s.skip_reason = (f"{self.s.streak_side.value} has closed "
                                   f"{self.s.streak_count} in a row; waiting for a reversal")
        else:
            self.s.trade_side_this_window = self.s.streak_side
            self.s.skip_reason = None

    def _record_equity_point(self):
        self.s.equity_curve.append({
            "window": self.s.window.slug if self.s.window else None,
            "ts": time.time(),
            "balance": round(self.s.balance, 2),
        })
        if len(self.s.equity_curve) > 500:
            self.s.equity_curve = self.s.equity_curve[-500:]

    def _settle(self, pos: Position, pnl: float, reason: str, exit_price: float,
                fee: float, rebate: float, note: str):
        self.s.total_pnl += pnl
        self.s.last_window_pnl = pnl
        self.s.exit_reason = reason
        self.s.balance += pnl
        won = pnl > 0
        if won:
            self.s.wins += 1
            self.s.martingale_streak = 0
            self.s.current_bet = config.ENGINE_BASE_BET
        else:
            self.s.losses += 1
            self.s.martingale_streak += 1
            self.s.max_losing_streak = max(self.s.max_losing_streak, self.s.martingale_streak)
            self.s.current_bet = self.s.current_bet * config.ENGINE_MARTINGALE_MULT
        event = "TP_CLOSE" if reason == "tp" else ("RESOLVE_WIN" if won else "RESOLVE_LOSS")
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", event,
            side=pos.side.value, price=exit_price, shares=pos.shares, fee=fee, pnl=pnl,
            balance_after=self.s.balance,
            note=f"{note}; balance ${self.s.balance:.2f}; next bet ${self.s.current_bet:.2f}",
        )
        self.s.position = None

        if self.s.balance < 0:
            self.s.halted = True
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "HALTED",
                balance_after=self.s.balance,
                note=f"balance ${self.s.balance:.2f} < $0 -- bankrupt, engine stopped permanently",
            )

    def _mark_price(self) -> Optional[float]:
        if self.s.position is None:
            return None
        return self.s.last_up_price if self.s.position.side == Side.UP else self.s.last_down_price

    def _unrealized_pnl(self) -> Optional[float]:
        mark = self._mark_price()
        if mark is None:
            return None
        pos = self.s.position
        return pos.shares * (mark - pos.entry_price)

    def snapshot(self) -> dict:
        win_total = self.s.wins + self.s.losses
        win_rate = (self.s.wins / win_total * 100) if win_total else None
        return {
            "current_bet": self.s.current_bet,
            "base_bet": config.ENGINE_BASE_BET,
            "martingale_streak": self.s.martingale_streak,
            "max_losing_streak": self.s.max_losing_streak,
            "total_pnl": self.s.total_pnl,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": win_rate,
            "no_trades": self.s.no_trades,
            "last_window_pnl": self.s.last_window_pnl,
            "balance": round(self.s.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.s.halted,
            "equity_curve": self.s.equity_curve[-150:],
            "streak_side": self.s.streak_side.value if self.s.streak_side else None,
            "streak_count": self.s.streak_count,
            "sitting_out": self.s.trade_side_this_window is None,
            "skip_reason": self.s.skip_reason,
            "status": ("halted" if self.s.halted else
                       ("open" if self.s.position is not None else
                        ("traded" if self.s.traded else
                         ("sitting_out" if self.s.trade_side_this_window is None else "waiting")))),
            "position": None if self.s.position is None else {
                "side": self.s.position.side.value,
                "shares": self.s.position.shares,
                "entry_price": self.s.position.entry_price,
                "mark_price": self._mark_price(),
                "unrealized_pnl": self._unrealized_pnl(),
            },
            "def": {
                "entry": config.ENGINE_ENTRY_PRICE,
                "tp": config.ENGINE_TP,
                "mult": config.ENGINE_MARTINGALE_MULT,
                "streak_filter_length": config.ENGINE_STREAK_FILTER_LENGTH,
            },
        }
