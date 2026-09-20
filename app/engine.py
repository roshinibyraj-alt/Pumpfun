"""
ALPHASTRIKE trading engine -- "the current window decides the next window".

Signal (app/strategy.py): from the five 1-minute closes of the window that
just closed. UP = minute 2 below minute 1 AND avg(min3-5) above avg(min1-2);
DOWN = the exact opposite; otherwise no trade.

Trade, in the NEXT window, on the signalled side -- ONE order type, a taker
market buy:
  1. ENTRY_DELAY_SECONDS (2s) after the window opens, buy TAKER_SHARES (300)
     at market, whatever the price (depth-walked fill, taker fee). If the
     signal is only known after that point, buy the moment it is known. If
     there is no ask / no depth, retry every tick until the window closes.
  2. No SL. TP 0.99 (taker sell), else forced taker close at window end.
  3. One entry per window.
"""
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .models import Side, WindowMarket
from .paper_broker import PaperBroker
from .strategy import SignalResult


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a
    real order book, instead of assuming the whole size fills at the
    single best quote. Used for the entry, the TP exit and the forced
    window-end close.

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
class Position:
    side: Side
    entry_price: float
    shares: float
    cost: float
    entry_ts: float


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window()
    at the start of every window. Cumulative stats live on the Engine
    itself so they survive across windows."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    # signal_status: pending (waiting for the previous window's candles) | armed (side chosen, entry due
    # ENTRY_DELAY_SECONDS after open) | no_pattern | no_data (candles never arrived) | late_join (bot
    # started mid-window)
    signal_status: str = "pending"
    signal: Optional[SignalResult] = None
    entered: bool = False            # the window's single entry has happened (stays True after TP)
    position: Optional[Position] = None
    entry_wait_logged: bool = False  # so the "no ask / no depth" note is logged once, not every tick
    last_window_pnl: float = 0.0


class Engine:
    name = "BOT"

    def __init__(self, broker: PaperBroker):
        self.broker = broker
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        self.history = deque(maxlen=30)      # one row per finished window, for the dashboard

        # ---- cumulative stats, survive across windows ----------------------
        self.total_signals_up = 0
        self.total_signals_down = 0
        self.total_no_pattern = 0
        self.total_no_data = 0
        self.signal_right = 0
        self.signal_wrong = 0
        self.total_taker_entries = 0
        self.total_no_fills = 0              # armed, but the book never had an ask/depth to buy into
        self.total_tp_fills = 0
        self.total_forced_closes = 0
        self.total_illiquid_skips = 0
        self.total_pnl = 0.0
        self.wins = 0
        self.losses = 0

    def _record_trade_result(self, pnl: float):
        if pnl >= 0:
            self.wins += 1
        else:
            self.losses += 1

    def _log(self, event, **kw):
        self.broker.log_event(self.name, self.s.window.slug if self.s.window else "", event,
                               balance_after=self.capital.balance, **kw)

    # ---- window lifecycle --------------------------------------------------------

    def reset_for_window(self, window: WindowMarket, late_join: bool = False):
        self.s = EngineState(window=window)
        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return
        if late_join:
            self.s.signal_status = "late_join"
            self._log("NO_TRADE", note="bot started mid-window -- skipping this window, trading from the next one")
            return
        self._log("WINDOW_OPEN", note=(
            f"ALPHASTRIKE: reading the previous window's 1-minute closes. Taker buy {config.TAKER_SHARES:.0f}sh "
            f"at market, {config.ENTRY_DELAY_SECONDS:g}s after open, on the signalled side, any price. "
            f"No SL, TP {config.TP_PRICE}"))

    def needs_signal(self) -> bool:
        return (self.s.window is not None and not self.capital.halted and self.s.signal_status == "pending")

    def set_signal(self, result: SignalResult, now: Optional[float] = None):
        """Called by state.py once the previous window's five minute-closes are in."""
        self.s.signal = result
        closes = " / ".join(f"{c:.2f}" for c in result.closes)
        if result.side is None:
            self.s.signal_status = "no_pattern"
            self.total_no_pattern += 1
            self._log("NO_SIGNAL", note=f"closes {closes} -- {result.reason}")
            return
        self.s.signal_status = "armed"
        if result.side == Side.UP:
            self.total_signals_up += 1
        else:
            self.total_signals_down += 1
        self._log("SIGNAL", side=result.side.value,
                   note=(f"closes {closes} -- {result.reason}. Taker buy {config.TAKER_SHARES:.0f}sh "
                         f"{result.side.value} at market from {config.ENTRY_DELAY_SECONDS:g}s after open"))

    def set_signal_unavailable(self, reason: str):
        self.s.signal_status = "no_data"
        self.total_no_data += 1
        self._log("NO_TRADE", note=f"previous window's candles unavailable ({reason}) -- skipping this window")

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

        if self.s.position is not None:
            self._check_exit(now)
            return
        if self._entry_due(now):
            self._try_entry(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    # ---- entry: one taker market buy, ENTRY_DELAY_SECONDS after open ---------

    def _entry_due(self, now: float) -> bool:
        s = self.s
        if s.signal_status != "armed" or s.entered or s.signal is None or s.signal.side is None:
            return False
        w = s.window
        return w.open_ts + config.ENTRY_DELAY_SECONDS <= now < w.close_ts

    def _try_entry(self, now: float):
        """Buy TAKER_SHARES at market on the signalled side -- no price cap. The fill is
        priced by walking real ask depth for the full size and pays the taker fee. With no ask or
        an empty book nothing is invented: it retries on the next tick until the window closes."""
        side = self.s.signal.side
        ask = self._ask_for(side)
        shares = config.TAKER_SHARES
        fill_price = _realistic_fill_price(self._ask_levels_for(side), shares, ask)
        if fill_price is None:
            if not self.s.entry_wait_logged:
                self.s.entry_wait_logged = True
                self.total_illiquid_skips += 1
                self._log("NO_LIQUIDITY", side=side.value, price=ask,
                           note=f"entry due but {side.value} has no ask / zero ask depth -- retrying every tick until window close")
            return
        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.total_taker_entries += 1
        self.s.entered = True
        self._log("TAKER_ENTRY", side=side.value, price=fill_price, shares=shares, fee=fee,
                   note=(f"taker buy filled @ {fill_price:.4f} (best ask {ask}), {shares:.0f}sh, "
                         f"fee ${fee:.4f}, total cost ${cost:.4f}, {now - self.s.window.open_ts:.1f}s after window open"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=fill_price, shares=shares, cost=cost, entry_ts=now)

    # ---- exit: TP only, no SL ------------------------------------------------

    def _check_exit(self, now: float):
        pos = self.s.position
        bid = self._bid_for(pos.side)
        if bid is None or bid < config.TP_PRICE:
            return
        levels = self._bid_levels_for(pos.side)
        fill_price = _realistic_fill_price(levels, pos.shares, bid)
        if fill_price is None:
            self.total_illiquid_skips += 1
            self._log("NO_LIQUIDITY", side=pos.side.value, price=bid, note=f"TP triggered @ {bid} but zero bid depth -- waiting")
            return
        fee = self.broker.taker_fee_amount(pos.shares, fill_price)
        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.total_pnl += pnl
        self.s.last_window_pnl += pnl
        self._record_trade_result(pnl)
        self.total_tp_fills += 1
        self._log("TP_FILL", side=pos.side.value, price=pos.entry_price, shares=pos.shares, pnl=pnl, fee=fee,
                   note=(f"TP hit, real fill @ {fill_price:.4f} (triggered @ {bid}) "
                         f"(entry {pos.entry_price:.4f}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window = self.s.window
        window_slug = window.slug
        sig = self.s.signal
        result_txt = None

        # Was the signal right? (signal side == the side that won the window it traded)
        if sig is not None and sig.side is not None and winning_side is not None:
            if sig.side == winning_side:
                self.signal_right += 1
            else:
                self.signal_wrong += 1
            self._log("SIGNAL_RESULT", side=sig.side.value,
                       note=f"window resolved {winning_side.value}: signal {sig.side.value} was "
                            f"{'RIGHT' if sig.side == winning_side else 'WRONG'}")

        if not self.capital.halted:
            if self.s.position is not None:
                pos = self.s.position
                bid = self._bid_for(pos.side)
                levels = self._bid_levels_for(pos.side)
                fill_price = _realistic_fill_price(levels, pos.shares, bid)
                if fill_price is None:
                    fill_price = 0.0
                    self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                               note="window closed with zero bid depth -- assuming worst case $0")
                fee = self.broker.taker_fee_amount(pos.shares, fill_price)
                proceeds = pos.shares * fill_price - fee
                pnl = proceeds - pos.cost
                self.capital.balance += proceeds
                self.total_pnl += pnl
                self.s.last_window_pnl += pnl
                self.total_forced_closes += 1
                self._record_trade_result(pnl)
                self._log("FORCED_CLOSE", side=pos.side.value, price=pos.entry_price, shares=pos.shares,
                           pnl=pnl, fee=fee,
                           note=(f"window closed, forced taker close @ {fill_price:.4f} "
                                 f"(entry {pos.entry_price:.4f}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                self.capital.check_halt()
                self.s.position = None
                result_txt = "taker entry, forced close"
            elif self.s.signal_status == "armed" and not self.s.entered:
                self.total_no_fills += 1
                self._log("ENTRY_MISSED", side=sig.side.value if (sig and sig.side) else "",
                           note="window closed and the entry never filled (no ask / no depth) -- no trade this window")
                result_txt = "no fill (empty book)"
            elif self.s.signal_status == "pending":
                self.total_no_data += 1
                self.s.signal_status = "no_data"
                self._log("NO_TRADE", note="previous window's candles never arrived for this window")

        if self.s.signal_status == "no_pattern":
            result_txt = "no pattern"
        elif self.s.signal_status == "no_data":
            result_txt = "no candle data"
        elif self.s.signal_status == "late_join":
            result_txt = "joined mid-window"
        if result_txt is None and self.s.entered:
            result_txt = "taker entry, TP hit"

        self.history.appendleft({
            "slug": window_slug, "open_ts": window.open_ts,
            "signal": sig.side.value if (sig and sig.side) else None,
            "closes": [round(c, 2) for c in sig.closes] if sig else None,
            "winner": winning_side.value if winning_side else None,
            "entry": "taker" if self.s.entered else None, "result": result_txt,
            "pnl": round(self.s.last_window_pnl, 2) if self.s.entered else None,
        })
        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        now = time.time()
        pos = self.s.position
        pos_payload = None
        open_market_value = 0.0
        unrealized = 0.0
        if pos is not None:
            bid = self._bid_for(pos.side)
            mark = bid if bid is not None else pos.entry_price
            open_market_value = pos.shares * mark
            unrealized = open_market_value - pos.cost
            pos_payload = {
                "side": pos.side.value, "entry_price": pos.entry_price, "shares": pos.shares,
                "cost": round(pos.cost, 4), "mark_price": mark, "unrealized_pnl": round(unrealized, 4),
                "seconds_since_entry": round(now - pos.entry_ts, 1),
            }

        # Armed and waiting to fire (the 2s delay, or an empty book): what the bot is about to buy.
        entry_payload = None
        sig = self.s.signal
        w = self.s.window
        if (w is not None and not self.capital.halted and self.s.signal_status == "armed"
                and not self.s.entered and sig is not None and sig.side is not None):
            entry_payload = {
                "side": sig.side.value, "shares": config.TAKER_SHARES,
                "fires_in": round(max(0.0, w.open_ts + config.ENTRY_DELAY_SECONDS - now), 1),
                "ask": self._ask_for(sig.side),
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif entry_payload is not None:
            status = "entry_pending"
        elif self.s.signal_status == "pending":
            status = "awaiting_signal"
        else:
            status = "done"

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None
        judged = self.signal_right + self.signal_wrong
        signal_acc = round(100 * self.signal_right / judged, 1) if judged else None

        return {
            "engine": "BOT", "label": "ALPHASTRIKE",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + open_market_value, 4),

            "realized_pnl": round(self.total_pnl, 4),
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(open_market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "position": pos_payload,
            "entry": entry_payload,
            "signal_status": self.s.signal_status,
            "signal": self.s.signal.to_dict() if self.s.signal else None,
            "history": list(self.history),

            "total_signals_up": self.total_signals_up,
            "total_signals_down": self.total_signals_down,
            "total_no_pattern": self.total_no_pattern,
            "total_no_data": self.total_no_data,
            "signal_right": self.signal_right,
            "signal_wrong": self.signal_wrong,
            "signal_accuracy": signal_acc,
            "total_taker_entries": self.total_taker_entries,
            "total_no_fills": self.total_no_fills,
            "total_tp_fills": self.total_tp_fills,
            "total_forced_closes": self.total_forced_closes,
            "total_illiquid_skips": self.total_illiquid_skips,

            "wins": self.wins,
            "losses": self.losses,
            "win_rate": win_rate,

            "status": status,

            "def": {
                "taker_shares": config.TAKER_SHARES,
                "entry_delay_s": config.ENTRY_DELAY_SECONDS,
                "tp_price": config.TP_PRICE,
            },
        }
