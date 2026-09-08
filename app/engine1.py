"""
Engine 1 -- dual-side race entry, martingale.

At window open, a resting limit buy is placed on BOTH sides at
ENGINE1_ENTRY_PRICE simultaneously. Whichever side's price walks down
to that level first fills; the other side's order is cancelled. Only
one position per window.

Exit: SL (checked first -- it's the closer/protective level) via a
market order, or TP via a limit sell, or Polymarket's real binary
resolution if neither fires by window close.

Bet sizing is a martingale ladder: a loss (SL or resolution loss)
multiplies the next window's bet by ENGINE1_MARTINGALE_MULT; a win
(TP or resolution win) resets it back to ENGINE1_BASE_BET. A window
where neither side ever reaches the entry price is not a trade and
does not move the ladder.

This is a genuinely dangerous bet-sizing scheme -- a martingale ladder
has no mathematical edge of its own and eventually meets either a
losing streak long enough to blow through available capital or a
platform bet-size ceiling. Validate the loss-streak tail risk in paper
mode before this ever touches real money.
"""
import time
from dataclasses import dataclass
from typing import Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class Engine1State:
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
    martingale_streak: int = 0  # consecutive losses feeding the current bet size


class Engine1:
    name = "E1"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = Engine1State(current_bet=config.ENGINE1_BASE_BET)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.traded = False
        self.s.position = None
        self.s.exit_reason = None
        self.s.entry_rebate = 0.0
        self.s.last_window_pnl = 0.0
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"resting buys on both sides @ {config.ENGINE1_ENTRY_PRICE}, "
                  f"tp {config.ENGINE1_TP}, sl {config.ENGINE1_SL}, "
                  f"next bet ${self.s.current_bet:.2f}"),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.s.window is None or up_price is None or down_price is None:
            return
        if not self.s.traded:
            self._check_entry(up_price, down_price)
        elif self.s.position is not None:
            self._check_exit(up_price, down_price)

    def _check_entry(self, up_price: float, down_price: float):
        entry = config.ENGINE1_ENTRY_PRICE
        up_hit = up_price <= entry
        down_hit = down_price <= entry
        if not up_hit and not down_hit:
            return
        # If both somehow qualify in the same tick, take the cheaper one --
        # it's the one that most clearly "walked through" the limit.
        if up_hit and down_hit:
            side = Side.UP if up_price <= down_price else Side.DOWN
        else:
            side = Side.UP if up_hit else Side.DOWN
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
            shares=shares, fee=-rebate,
            note=(f"race entry: {side.value} filled @ {fill_price}, other side cancelled, "
                  f"bet ${bet:.2f} (rebate ${rebate:.4f})"),
        )

    def _check_exit(self, up_price: float, down_price: float):
        pos = self.s.position
        price = up_price if pos.side == Side.UP else down_price
        if price <= config.ENGINE1_SL:
            self._close(price, "sl", fee=self.broker.taker_fee_amount(pos.shares, price), rebate=0.0)
            return
        if price >= config.ENGINE1_TP:
            rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(pos.shares, price)
            self._close(price, "tp", fee=0.0, rebate=rebate)

    def _close(self, price: float, reason: str, fee: float, rebate: float):
        pos = self.s.position
        proceeds = pos.shares * price
        pnl = proceeds - pos.notional - fee + rebate + self.s.entry_rebate
        self._settle(pos, pnl, reason, price, fee, rebate,
                     note=f"{'take-profit' if reason=='tp' else 'stop-loss (market order)'}")

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.position is not None:
            pos = self.s.position
            won = winning_side is not None and pos.side == winning_side
            proceeds = pos.shares * (1.0 if won else 0.0)
            pnl = proceeds - pos.notional + self.s.entry_rebate
            self._settle(pos, pnl, "resolution", 1.0 if won else 0.0, 0.0, 0.0,
                         note="held to resolution (no TP/SL hit)")
        elif not self.s.traded:
            self.s.no_trades += 1
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "NO_TRADE",
                note="neither side reached the entry price this window; bet size unchanged",
            )
        self.s.window = None

    def _settle(self, pos: Position, pnl: float, reason: str, exit_price: float,
                fee: float, rebate: float, note: str):
        self.s.total_pnl += pnl
        self.s.last_window_pnl = pnl
        self.s.exit_reason = reason
        won = pnl > 0
        if won:
            self.s.wins += 1
            self.s.martingale_streak = 0
            self.s.current_bet = config.ENGINE1_BASE_BET
        else:
            self.s.losses += 1
            self.s.martingale_streak += 1
            self.s.current_bet = self.s.current_bet * config.ENGINE1_MARTINGALE_MULT
        event = "TP_CLOSE" if reason == "tp" else ("SL_CLOSE" if reason == "sl" else
                 ("RESOLVE_WIN" if won else "RESOLVE_LOSS"))
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", event,
            side=pos.side.value, price=exit_price, shares=pos.shares, fee=fee, pnl=pnl,
            note=f"{note}; next bet ${self.s.current_bet:.2f}",
        )
        self.s.position = None

    def snapshot(self) -> dict:
        return {
            "current_bet": self.s.current_bet,
            "base_bet": config.ENGINE1_BASE_BET,
            "martingale_streak": self.s.martingale_streak,
            "total_pnl": self.s.total_pnl,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "no_trades": self.s.no_trades,
            "last_window_pnl": self.s.last_window_pnl,
            "status": ("open" if self.s.position is not None else
                       ("traded" if self.s.traded else "waiting")),
            "position": None if self.s.position is None else {
                "side": self.s.position.side.value,
                "shares": self.s.position.shares,
                "entry_price": self.s.position.entry_price,
            },
            "def": {
                "entry": config.ENGINE1_ENTRY_PRICE,
                "tp": config.ENGINE1_TP,
                "sl": config.ENGINE1_SL,
                "mult": config.ENGINE1_MARTINGALE_MULT,
            },
        }
