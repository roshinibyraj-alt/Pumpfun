"""
Trading engine -- BTC-spot-trend entry (buys the direction BTC itself
has been trending in, not the previous window's winner or the token's
own cheapness), single trade per window, TP redemption, no stop-loss
of any kind.

See app/config.py for the full strategy write-up, and app/btc_trend.py
for how the trend signal itself is computed. Summary: a short delay
after window open (ENTRY_SETTLE_SECONDS, just long enough for book
data to exist), the engine looks at whatever BTC trend it was last
told about (see on_tick's btc_trend argument, fed by app/state.py from
a BtcTrendTracker that runs continuously off real BTC spot price,
independent of the window clock). If there's no clear trend, the
window is skipped outright. If there is, the target side is UP for an
uptrend or DOWN for a downtrend; if that side's price is below
ENTRY_PRICE_THRESHOLD (0.40), it's bought immediately, flat
BASE_ORDER_SHARES; otherwise no trade is taken this window -- this is
a single check, not a rearmed watch. Once filled, the position has
exactly two ways out: TP_PRICE (0.99) hit -> redeemed at a flat
$1.00/share, fee-free (a CTF resolution redemption, not an orderbook
trade); or the window closes first, in which case it's force-closed at
whatever the market will pay (a real taker sell, priced off real bid
depth). There is no stop-loss of any kind -- a position that's deep
underwater just keeps riding it out until one of those two things
happens; mid price is what triggers the TP check, but every actual
fill (entry, or the forced close) is a real taker execution priced off
real ask/bid order-book depth (see Engine._realistic_fill_price), so
mid and fill price can differ by the spread. No flip, no re-entry on
the other side -- at most one trade per window. No martingale
anywhere; every entry is BASE_ORDER_SHARES. Every fill except TP is a
taker order and pays the taker fee; TP is the sole fee-free exception
since it's a CTF resolution redemption, not an orderbook trade.
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


# ---------------------------------------------------------------------------
# The single open position for a window, if any.
# ---------------------------------------------------------------------------

@dataclass
class Position:
    side: Side
    shares: float
    entry_price: float
    entry_fee: float
    entry_ts: float

    @property
    def cost(self) -> float:
        return self.shares * self.entry_price + self.entry_fee


@dataclass
class EngineState:
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None

    # Full order-book depth for the current tick, when available. None
    # means "no depth data this tick" (fall back to the scalar price for
    # the whole size); an empty list means "book fetched fine, there is
    # genuinely nothing resting on this side" -- a real no-liquidity
    # signal, not a data gap. See Engine._realistic_fill_price.
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    position: Optional[Position] = None
    entry_checked: bool = False     # the single entry check (t=ENTRY_SETTLE_SECONDS) has happened
    btc_trend: Optional[Side] = None   # latest BTC trend read, refreshed every tick via on_tick's
                                        # btc_trend argument -- Side.UP/Side.DOWN/None, captured at
                                        # whatever value it holds at the moment of the entry check
    done_for_window: bool = False   # TP or stop hit, or window closed with nothing open -- nothing left to watch

    total_entries_attempted: int = 0   # entry checks where the trend side was below threshold and bought
    total_price_too_high: int = 0      # entry checks where the trend side was at/above ENTRY_PRICE_THRESHOLD
    total_tp_hits: int = 0
    total_forced_closes: int = 0       # window closed before TP was reached
    no_trade_windows: int = 0          # no clear trend, or trend side was too expensive -- nothing opened
    wins: int = 0
    losses: int = 0
    total_pnl: float = 0.0
    last_window_pnl: float = 0.0


class Engine:
    """BTC-spot-trend entry (buys the direction BTC itself has been
    trending in) / single trade per window / no stop-loss of any kind
    -- TP or the forced window-end close are the only two ways out --
    driven off its own capital pool. Kept as the class name `Engine` /
    constructed the same way (Engine(broker)) so app/state.py doesn't
    need structural changes."""

    name = "FLIP"

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

        self._log("WINDOW_OPEN", shares=config.BASE_ORDER_SHARES, note=(
            f"waiting {config.ENTRY_SETTLE_SECONDS:.0f}s, then checking the BTC trend -- if it's clearly "
            f"up, buy UP; if clearly down, buy DOWN; if no clear trend, skip this window entirely. The "
            f"trend side is only bought if its price is below {config.ENTRY_PRICE_THRESHOLD} at that "
            f"single check (no rearmed watch) -- flat {config.BASE_ORDER_SHARES:.0f}sh, no martingale. "
            f"TP {config.TP_PRICE} (redeem $1) is the only take-profit; no stop-loss of any kind -- "
            f"the position rides everything else out until TP or the window closes and it's forced out. "
            f"One trade per window -- no flip, no re-entry."
        ))

    def on_tick(self, up_bid, up_ask, down_bid, down_ask, seconds_to_close: float = None, now: Optional[float] = None,
                up_bid_levels: Optional[list] = None, up_ask_levels: Optional[list] = None,
                down_bid_levels: Optional[list] = None, down_ask_levels: Optional[list] = None,
                btc_trend: Optional[Side] = None):
        if self.s.window is None or self.capital.halted:
            return
        now = now if now is not None else time.time()
        self.s.up_bid, self.s.up_ask = up_bid, up_ask
        self.s.down_bid, self.s.down_ask = down_bid, down_ask
        self.s.up_bid_levels, self.s.up_ask_levels = up_bid_levels, up_ask_levels
        self.s.down_bid_levels, self.s.down_ask_levels = down_bid_levels, down_ask_levels
        self.s.btc_trend = btc_trend

        if self.s.done_for_window:
            return

        if self.s.position is None:
            self._check_entry(now)
        else:
            self._check_exit(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _mid_for(self, side: Side) -> Optional[float]:
        return _midpoint(self._bid_for(side), self._ask_for(side))

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    @staticmethod
    def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
        """Volume-weighted average price to actually trade `shares`
        against a real order book, instead of assuming the whole size
        fills at the single best quote.

        - levels is None -> no depth data this tick; fall back to
          filling the whole size at `fallback_price`.
        - levels is [] -> book fetched fine, genuinely nothing resting
          on this side; return None, caller must not invent a fill.
        - levels is non-empty -> walk best-price-first; any shortfall
          in visible depth is priced at the worst level seen.
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

    # ---- entry: single check at ENTRY_SETTLE_SECONDS -- BTC trend picks --
    # ---- the side, ENTRY_PRICE_THRESHOLD decides whether to fire ---------

    def _check_entry(self, now: float):
        elapsed = now - self.s.window.open_ts
        if elapsed < config.ENTRY_SETTLE_SECONDS:
            return   # not yet -- keep waiting, don't mark checked

        self.s.entry_checked = True

        trend = self.s.btc_trend
        if trend is None:
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", note=(
                f"no clear BTC trend at the {config.ENTRY_SETTLE_SECONDS:.0f}s check "
                f"(last {config.BTC_TREND_LOOKBACK_BLOCKS} blocks weren't cleanly monotonic) -- "
                f"skipping window"
            ))
            return

        price = self._mid_for(trend)
        if price is None:
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", side=trend.value,
                       note="no price data at the entry check -- skipping window")
            return

        if price >= config.ENTRY_PRICE_THRESHOLD:
            self.s.total_price_too_high += 1
            self.s.no_trade_windows += 1
            self.s.done_for_window = True
            self._log("NO_TRADE", side=trend.value, price=round(price, 4), note=(
                f"BTC trend side {trend.value} mid @ {price:.4f} is at/above the "
                f"{config.ENTRY_PRICE_THRESHOLD} entry threshold at the "
                f"{config.ENTRY_SETTLE_SECONDS:.0f}s check -- no trade this window"
            ))
            return

        self.s.total_entries_attempted += 1
        self._open_position(trend, now, zone_note=(
            f"BTC trend is {trend.value} (last {config.BTC_TREND_LOOKBACK_BLOCKS} 30s blocks monotonic), "
            f"{trend.value} mid @ {price:.4f} < {config.ENTRY_PRICE_THRESHOLD}"
        ))

    # ---- position open (single entry per window) ---------------------------

    def _open_position(self, side: Side, now: float, zone_note: str):
        shares = config.BASE_ORDER_SHARES
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill_price = self._realistic_fill_price(levels, shares, ask)

        if fill_price is None:
            self._log("NO_LIQUIDITY", side=side.value,
                       note=f"no ask liquidity on {side.value} -- entry skipped")
            self.s.done_for_window = True
            self.s.no_trade_windows += 1
            return

        fee = self.broker.taker_fee_amount(shares, fill_price)
        cost = shares * fill_price + fee
        self.capital.balance -= cost
        self.s.position = Position(side=side, shares=shares, entry_price=fill_price, entry_fee=fee,
                                    entry_ts=now)
        self._log("ENTRY_FILL", side=side.value, price=round(fill_price, 4), shares=shares, fee=round(fee, 4),
                   note=(f"entry buy filled (taker, real ask depth): {shares:.0f}sh @ {fill_price:.4f} "
                         f"({zone_note}, fee ${fee:.4f}) -- TP {config.TP_PRICE} (redeem $1) is the only "
                         f"exit besides a forced window-end close; no stop-loss"))
        self.capital.check_halt()

    # ---- exit: TP redemption only -- no stop-loss of any kind --------------

    def _check_exit(self, now: float):
        pos = self.s.position
        mid = self._mid_for(pos.side)
        if mid is None:
            return

        if mid >= config.TP_PRICE:
            self.s.total_tp_hits += 1
            self._close_position(now, reason="TP_HIT",
                                  note_prefix=f"take-profit hit ({config.TP_PRICE} mid)",
                                  fill_price_override=1.0, fee_override=0.0)

    def _close_position(self, now: float, reason: str, note_prefix: str,
                         fill_price_override: Optional[float] = None, fee_override: Optional[float] = None):
        pos = self.s.position
        if fill_price_override is not None:
            # TP: booked as a CTF resolution redemption, not an orderbook
            # trade -- flat $1.00/share, no fee, no book-depth lookup.
            fill_price = fill_price_override
            fee = fee_override if fee_override is not None else 0.0
        else:
            # Real taker sell against actual bid depth -- mid only decides
            # WHEN to exit, never what price it fills at.
            bid = self._bid_for(pos.side)
            levels = self._bid_levels_for(pos.side)
            fill_price = self._realistic_fill_price(levels, pos.shares, bid)
            if fill_price is None:
                # confirmed empty book -- nobody bidding at all right now
                fill_price = 0.0
                self._log("NO_LIQUIDITY", side=pos.side.value, price=bid,
                           note=f"{reason} but book has zero bid depth on {pos.side.value} -- assuming worst case $0")
            fee = self.broker.taker_fee_amount(pos.shares, fill_price)

        proceeds = pos.shares * fill_price - fee
        pnl = proceeds - pos.cost
        self.capital.balance += proceeds
        self.s.total_pnl += pnl
        self.s.last_window_pnl += pnl
        win = pnl >= 0
        if win:
            self.s.wins += 1
        else:
            self.s.losses += 1

        self._log(reason, side=pos.side.value, price=round(fill_price, 4), shares=pos.shares,
                   fee=round(fee, 4), pnl=round(pnl, 4),
                   note=(f"{note_prefix} ({'redemption, fee-free' if fill_price_override is not None else 'taker'}, "
                         f"@ {fill_price:.4f}): {pos.shares:.0f}sh (entry {pos.entry_price:.4f}, "
                         f"fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

        # TP or a forced window-end close -- every close is terminal now:
        # one trade per window, no flip/re-entry, no stop-loss to trigger
        # in between.
        self.s.done_for_window = True

    # ---- window close -------------------------------------------------------

    def finalize_window(self):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        if not self.capital.halted:
            if self.s.position is not None:
                self.s.total_forced_closes += 1
                self._close_position(time.time(), reason="FORCED_CLOSE",
                                      note_prefix="window closed before TP, forced taker close")
            elif not self.s.entry_checked:
                self.s.no_trade_windows += 1
                self._log("NO_TRADE", note="window closed before the entry check ever ran")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def _position_payload(self) -> Optional[dict]:
        pos = self.s.position
        if pos is None:
            return None
        mid = self._mid_for(pos.side)
        mark = mid if mid is not None else pos.entry_price
        market_value = pos.shares * mark
        unrealized = market_value - pos.cost
        to_tp = round(config.TP_PRICE - mark, 4)

        return {
            "side": pos.side.value,
            "shares": pos.shares,
            "entry_price": round(pos.entry_price, 4),
            "entry_fee": round(pos.entry_fee, 4),
            "entry_ts": pos.entry_ts,
            "mark_price": mark,
            "market_value": round(market_value, 4),
            "unrealized_pnl": round(unrealized, 4),
            "tp_price": config.TP_PRICE,
            "distance_to_tp": to_tp,
        }

    def snapshot(self) -> dict:
        position = self._position_payload()
        market_value = position["market_value"] if position else 0.0
        unrealized = position["unrealized_pnl"] if position else 0.0
        realized_pnl = round(self.s.total_pnl, 4)

        if self.capital.halted:
            status = "halted"
        elif position is not None:
            status = "in_position"
        elif not self.s.entry_checked:
            status = "waiting_entry"
        else:
            status = "done"

        up_mid = self._mid_for(Side.UP)
        down_mid = self._mid_for(Side.DOWN)

        return {
            "engine": "FLIP", "label": "BTC-trend entry (buys the direction BTC itself is trending), single trade, TP only — no stop-loss",

            "balance": round(self.capital.balance, 2),
            "starting_capital": config.STARTING_CAPITAL,
            "halted": self.capital.halted,
            "equity_curve": self.capital.equity_curve,
            "equity": round(self.capital.balance + market_value, 4),

            "realized_pnl": realized_pnl,
            "unrealized_pnl": round(unrealized, 4),
            "open_market_value": round(market_value, 4),
            "last_window_pnl": round(self.s.last_window_pnl, 4),

            "up_mid": up_mid,
            "down_mid": down_mid,
            "btc_trend": self.s.btc_trend.value if self.s.btc_trend else None,
            "entry_checked": self.s.entry_checked,
            "position": position,
            "done_for_window": self.s.done_for_window,

            "base_order_shares": config.BASE_ORDER_SHARES,

            "total_entries_attempted": self.s.total_entries_attempted,
            "total_price_too_high": self.s.total_price_too_high,
            "total_tp_hits": self.s.total_tp_hits,
            "total_forced_closes": self.s.total_forced_closes,
            "no_trade_windows": self.s.no_trade_windows,
            "wins": self.s.wins,
            "losses": self.s.losses,
            "win_rate": round(100 * self.s.wins / (self.s.wins + self.s.losses), 1) if (self.s.wins + self.s.losses) else None,

            "status": status,

            "def": {
                "entry_settle_seconds": config.ENTRY_SETTLE_SECONDS,
                "entry_price_threshold": config.ENTRY_PRICE_THRESHOLD,
                "btc_block_seconds": config.BTC_BLOCK_SECONDS,
                "btc_trend_history_blocks": config.BTC_TREND_HISTORY_BLOCKS,
                "btc_trend_lookback_blocks": config.BTC_TREND_LOOKBACK_BLOCKS,
                "tp_price": config.TP_PRICE,
                "base_order_shares": config.BASE_ORDER_SHARES,
            },
        }
