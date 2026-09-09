"""
Trading engine -- dual-order entry, sized off the previous window's
winner, no filters, no martingale, no stop loss.

Entry: at window open, TWO resting limit buy orders are placed at once,
both at ENGINE_ENTRY_PRICE:
  - one on UP
  - one on DOWN
Sizes are asymmetric based on which side won the PREVIOUS window:
  - previous winner UP   -> UP order = ENGINE_FAVORITE_SHARES,
                             DOWN order = ENGINE_UNDERDOG_SHARES
  - previous winner DOWN -> DOWN order = ENGINE_FAVORITE_SHARES,
                             UP order = ENGINE_UNDERDOG_SHARES
Whichever side's price reaches ENGINE_ENTRY_PRICE first fills; the
other order is cancelled immediately. At most one open position per
window. If neither side reaches ENGINE_ENTRY_PRICE by close, no trade
happens that window.

No filters -- every window with a known previous winner gets both
orders placed; there's no streak logic or sitting out on a run. Only
exception: the very first window ever (no prior winner yet) and any
window whose predecessor's outcome couldn't be determined.

No martingale -- size is always this fixed favorite/underdog split, win
or lose. It never scales with results.

Exit: TP via a limit sell, or window resolution if TP isn't hit by
close. There is no stop loss -- a losing trade always rides all the way
to resolution ($0/share if it loses), rather than being cut early at a
partial loss.

Capital: the engine tracks the app's one and only balance, starting at
config.STARTING_CAPITAL. This is what the dashboard's "Demo Capital"
figure shows. If a loss ever takes it below $0, the engine halts
permanently (no further entries) -- a hard bankruptcy stop.

Validate in paper mode before this ever touches real money -- betting
2x size on the previous winner is a directional bet that up/down
outcomes are streak-prone; if 5-minute BTC windows are close to
independent, it has no real edge, and the 500-share side losing is a
bigger notional hit than the 250-share side losing.
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
    total_pnl: float = 0.0
    wins: int = 0
    losses: int = 0
    no_trades: int = 0
    last_window_pnl: float = 0.0
    last_up_price: Optional[float] = None
    last_down_price: Optional[float] = None

    # this window's two resting orders, sized off the previous winner.
    # None/None = sitting out (no prior winner known yet).
    order_up_shares: Optional[float] = None
    order_down_shares: Optional[float] = None
    favorite_side: Optional[Side] = None   # the side that won the previous window
    skip_reason: Optional[str] = None      # why there are no orders this window, for logging

    # capital
    balance: float = 0.0
    halted: bool = False
    equity_curve: List[dict] = field(default_factory=list)  # [{window, balance}, ...]


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.s = EngineState(balance=config.STARTING_CAPITAL,
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

        if self.s.favorite_side is None:
            self.s.order_up_shares = None
            self.s.order_down_shares = None
            self.broker.log_event(
                self.name, window.slug, "WINDOW_OPEN",
                note=f"sitting out this window ({self.s.skip_reason}); no orders placed",
                balance_after=self.s.balance,
            )
        else:
            underdog = self.s.favorite_side.other()
            self.s.order_up_shares = (config.ENGINE_FAVORITE_SHARES if self.s.favorite_side == Side.UP
                                       else config.ENGINE_UNDERDOG_SHARES)
            self.s.order_down_shares = (config.ENGINE_FAVORITE_SHARES if self.s.favorite_side == Side.DOWN
                                         else config.ENGINE_UNDERDOG_SHARES)
            self.broker.log_event(
                self.name, window.slug, "WINDOW_OPEN",
                note=(f"two limit buys @ {config.ENGINE_ENTRY_PRICE}: "
                      f"{self.s.favorite_side.value} {config.ENGINE_FAVORITE_SHARES:.0f}sh (favorite, won previous window), "
                      f"{underdog.value} {config.ENGINE_UNDERDOG_SHARES:.0f}sh (underdog); "
                      f"first fill wins, other order cancelled"),
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
        if self.s.order_up_shares is None and self.s.order_down_shares is None:
            return  # sitting out this window
        entry = config.ENGINE_ENTRY_PRICE
        up_hit = up_price <= entry
        down_hit = down_price <= entry
        if not up_hit and not down_hit:
            return
        if up_hit and down_hit:
            # Both crossed within the same poll tick -- treat the side
            # that dipped further below the entry price as the one that
            # would have filled first.
            winner = Side.UP if up_price <= down_price else Side.DOWN
        else:
            winner = Side.UP if up_hit else Side.DOWN
        self._fill_entry(winner, entry)

    def _fill_entry(self, side: Side, fill_price: float):
        shares = self.s.order_up_shares if side == Side.UP else self.s.order_down_shares
        cancelled_side = side.other()
        cancelled_shares = self.s.order_up_shares if cancelled_side == Side.UP else self.s.order_down_shares

        rebate = config.MAKER_REBATE_FRACTION * self.broker.taker_fee_amount(shares, fill_price)
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, fee=0.0)
        self.s.entry_rebate = rebate
        self.s.traded = True
        self.broker.log_event(
            self.name, self.s.window.slug, "BUY", side=side.value, price=fill_price,
            shares=shares, fee=-rebate, balance_after=self.s.balance,
            note=f"filled first: {side.value} {shares:.0f}sh @ {fill_price} (rebate ${rebate:.4f})",
        )
        self.broker.log_event(
            self.name, self.s.window.slug, "CANCEL", side=cancelled_side.value,
            shares=cancelled_shares, balance_after=self.s.balance,
            note=f"cancelled unfilled {cancelled_side.value} order ({cancelled_shares:.0f}sh @ {fill_price})",
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
            self._update_next_favorite(winning_side)
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
            reason = "sitting out" if self.s.favorite_side is None and self.s.window is not None else "neither side reached entry price"
            self.broker.log_event(
                self.name, self.s.window.slug if self.s.window else "", "NO_TRADE",
                balance_after=self.s.balance,
                note=f"no trade this window ({reason})",
            )

        self._record_equity_point()
        self._update_next_favorite(winning_side)
        self.s.window = None

    def _update_next_favorite(self, winning_side: Optional[Side]):
        """Next window's favorite (500-share) side is simply whichever
        side just won. Up wins -> up is favorite next window. Down wins
        -> down is favorite. No filters, no martingale -- purely this
        binary rule each window."""
        if winning_side is None:
            # Couldn't confirm the outcome -- stay cautious, sit out
            # next window rather than guess.
            self.s.favorite_side = None
            self.s.skip_reason = "previous window's outcome could not be determined"
            return
        self.s.favorite_side = winning_side
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
        else:
            self.s.losses += 1
        event = "TP_CLOSE" if reason == "tp" else ("RESOLVE_WIN" if won else "RESOLVE_LOSS")
        self.broker.log_event(
            self.name, self.s.window.slug if self.s.window else "", event,
            side=pos.side.value, price=exit_price, shares=pos.shares, fee=fee, pnl=pnl,
            balance_after=self.s.balance,
            note=f"{note}; balance ${self.s.balance:.2f}",
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
            "favorite_side": self.s.favorite_side.value if self.s.favorite_side else None,
            "underdog_side": self.s.favorite_side.other().value if self.s.favorite_side else None,
            "order_up_shares": self.s.order_up_shares,
            "order_down_shares": self.s.order_down_shares,
            "sitting_out": self.s.favorite_side is None,
            "skip_reason": self.s.skip_reason,
            "status": ("halted" if self.s.halted else
                       ("open" if self.s.position is not None else
                        ("traded" if self.s.traded else
                         ("sitting_out" if self.s.favorite_side is None else "waiting")))),
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
                "favorite_shares": config.ENGINE_FAVORITE_SHARES,
                "underdog_shares": config.ENGINE_UNDERDOG_SHARES,
            },
        }
