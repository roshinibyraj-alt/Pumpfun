"""
Engine 2 -- delayed dip-fill entry, martingale.

Does nothing for the first ENGINE2_WAIT_SECONDS of the window. After
that, watches both sides: the first time either side's price is
observed at or above ENGINE2_ENTRY_PRICE, a resting limit buy is
*armed* at that price -- but a limit buy order only actually fills
when the market trades AT OR BELOW that price, never while price is
sitting above it. So if price is already above entry the moment the
wait elapses (or rises straight through it later), the order arms but
does not fill; it only fills once price subsequently walks back down
through ENGINE2_ENTRY_PRICE. If it never comes back down, no trade
happens that window and the bet ladder is unaffected. Only one
position per window.

Same exit logic (SL checked first, then TP, then real resolution
fallback) and same martingale rules (loss -> bet * ENGINE2_MARTINGALE_MULT,
win -> reset to ENGINE2_BASE_BET, no-trade window doesn't move the
ladder) as Engine 1 -- see engine1.py's docstring for the tail-risk
caveat, which applies here too.
"""
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

from . import config
from .models import Position, Side, WindowMarket
from .paper_broker import PaperBroker


@dataclass
class Engine2State:
    window: Optional[WindowMarket] = None
    armed: Dict[Side, bool] = field(default_factory=lambda: {Side.UP: False, Side.DOWN: False})
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
    martingale_streak: int = 0
    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None


class Engine2:
    name = "E2"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = Engine2State(current_bet=config.ENGINE2_BASE_BET)

    def reset_for_window(self, window: WindowMarket):
        self.s.window = window
        self.s.armed = {Side.UP: False, Side.DOWN: False}
        self.s.traded = False
        self.s.position = None
        self.s.exit_reason = None
        self.s.entry_rebate = 0.0
        self.s.last_window_pnl = 0.0
        self.broker.log_event(
            self.name, window.slug, "WINDOW_OPEN",
            note=(f"waiting {config.ENGINE2_WAIT_SECONDS}s, then arm @ "
                  f"{config.ENGINE2_ENTRY_PRICE} on touch, fill only on the dip back "
                  f"through it -- tp {config.ENGINE2_TP}, sl {config.ENGINE2_SL}, "
                  f"next bet ${self.s.current_bet:.2f}"),
        )

    def on_tick(self, up_price: Optional[float], down_price: Optional[float],
                seconds_to_close: float, now: Optional[float] = None):
        if self.s.window is None or up_price is None or down_price is None:
            return
        self.s.last_up_price = up_price
        self.s.last_down_price = down_price
        now = now or time.time()
        elapsed = now - self.s.window.open_ts
        if elapsed < config.ENGINE2_WAIT_SECONDS:
            return
        if not self.s.traded:
            self._check_entry(up_price, down_price)
        elif self.s.position is not None:
            self._check_exit(up_price, down_price)

    def _check_entry(self, up_price: float, down_price: float):
        entry = config.ENGINE2_ENTRY_PRICE
        prices = {Side.UP: up_price, Side.DOWN: down_price}
        for side in (Side.UP, Side.DOWN):
            if self.s.traded:
                return
            price = prices[side]
            if not self.s.armed[side]:
                if price >= entry:
                    self.s.armed[side] = True
                    self.broker.log_event(
                        self.name, self.s.window.slug, "ARMED", side=side.value, price=price,
                        note=f"{side.value} touched {entry}, resting buy armed -- waiting for a fill on the dip back to {entry}",
                    )
                else:
                    continue
            if self.s.armed[side] and price <= entry:
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
            note=(f"dip-fill entry: {side.value} @ {fill_price} (armed after "
                  f"{config.ENGINE2_WAIT_SECONDS}s wait, filled on the pullback), "
                  f"bet ${bet:.2f} (rebate ${rebate:.4f})"),
        )

    def _check_exit(self, up_price: float, down_price: float):
        pos = self.s.position
        price = up_price if pos.side == Side.UP else down_price
        if price <= config.ENGINE2_SL:
            self._close(price, "sl", fee=self.broker.taker_fee_amount(pos.shares, price), rebate=0.0)
            return
        if price >= config.ENGINE2_TP:
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
                note="price never reached the entry level after the wait; bet size unchanged",
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
            self.s.current_bet = config.ENGINE2_BASE_BET
        else:
            self.s.losses += 1
            self.s.martingale_streak += 1
            self.s.current_bet = self.s.current_bet * config.ENGINE2_MARTINGALE_MULT
        event = "TP_CLOSE" if reason == "tp" else ("SL_CLOSE" if reason == "sl" else
                 ("RESOLVE_WIN" if won else "RESOLVE_LOSS"))
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", event,
            side=pos.side.value, price=exit_price, shares=pos.shares, fee=fee, pnl=pnl,
            note=f"{note}; next bet ${self.s.current_bet:.2f}",
        )
        self.s.position = None

    def _mark_price(self) -> Optional[float]:
        if self.s.position is None:
            return None
        return self.s.last_up_price if self.s.position.side == Side.UP else self.s.last_down_price

    def _unrealized_pnl(self) -> Optional[float]:
        """Mark-to-market PnL if the open position were sold at the last
        observed price right now. Ignores the exit fee/rebate that would
        actually apply, since we don't yet know whether it'll close via
        TP, SL, or resolution -- this is a live floating estimate, not a
        settled number."""
        mark = self._mark_price()
        if mark is None:
            return None
        pos = self.s.position
        return pos.shares * (mark - pos.entry_price)

    def snapshot(self) -> dict:
        return {
            "current_bet": self.s.current_bet,
            "base_bet": config.ENGINE2_BASE_BET,
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
                "mark_price": self._mark_price(),
                "unrealized_pnl": self._unrealized_pnl(),
            },
            "def": {
                "wait_seconds": config.ENGINE2_WAIT_SECONDS,
                "entry": config.ENGINE2_ENTRY_PRICE,
                "tp": config.ENGINE2_TP,
                "sl": config.ENGINE2_SL,
                "mult": config.ENGINE2_MARTINGALE_MULT,
            },
        }
