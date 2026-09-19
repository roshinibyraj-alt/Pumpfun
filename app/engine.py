"""Trading engine for the directional multi-timeframe strategy.

At each 5-minute window the signal engine predicts UP or DOWN from completed
1D/4H/1H/15M indicators and the walk-forward learner. The engine buys that
same side; it never fades the prediction. Weak or conflicting signals are
recorded and skipped. A qualifying signal waits two seconds after window open
and then executes one depth-priced taker buy; window-end settlement remains
unchanged.
"""
import time
from dataclasses import dataclass, field
from typing import Optional

from . import config
from .ai_signal import AISignalEngine
from .binance_client import BinanceKlineFeed
from .models import Side, WindowMarket
from .paper_broker import PaperBroker


def _realistic_fill_price(levels: Optional[list], shares: float, fallback_price: Optional[float]) -> Optional[float]:
    """Volume-weighted average price to actually trade `shares` against a
    real order book, instead of assuming the whole size fills at the
    single best quote. Used for the taker entry, TP exit and forced close.

    - levels is None -> no depth data this tick; fall back to filling
      the whole size at `fallback_price`.
    - levels is [] -> book fetched fine, genuinely no ask/bid depth on
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
    signal_side: Optional[Side] = None
    entry_type: str = "taker"


@dataclass
class EngineState:
    """Per-window transient state -- fully replaced by reset_for_window()
    at the start of every window. Cumulative stats live on the Engine
    itself, below, so they survive across windows instead of getting
    wiped every 5 minutes."""
    window: Optional[WindowMarket] = None
    up_bid: Optional[float] = None
    up_ask: Optional[float] = None
    down_bid: Optional[float] = None
    down_ask: Optional[float] = None
    up_bid_levels: Optional[list] = None
    up_ask_levels: Optional[list] = None
    down_bid_levels: Optional[list] = None
    down_ask_levels: Optional[list] = None

    position: Optional[Position] = None
    decision_made: bool = False     # True once the AI signal has been decided (whichever way it went)
    decided_color: Optional[str] = None
    ai_features: Optional[object] = None    # multi-timeframe feature bundle for online learning
    ai_predicted_side: Optional[Side] = None
    entry_attempted: bool = False
    entry_wait_logged: bool = False
    ai_confidence: Optional[float] = None
    ai_reason: Optional[str] = None
    ai_tradeable: bool = False

    last_window_pnl: float = 0.0


class Engine:
    """Directional signal engine driven off a single shared
    capital pool. Constructed as Engine(broker, binance_feed) --
    app/state.py owns the BinanceKlineFeed instance and passes it in."""

    name = "PREVCANDLE"

    def __init__(self, broker: PaperBroker, binance_feed: BinanceKlineFeed):
        self.broker = broker
        self.binance_feed = binance_feed
        self.capital = CapitalPool(balance=config.STARTING_CAPITAL)
        self.s = EngineState()
        self.capital.record_equity_point(None)
        self.ai = AISignalEngine()

        # ---- cumulative stats, survive across windows ----------------------
        self.total_orders_placed = 0
        self.total_order_fills = 0
        self.total_tp_fills = 0
        self.total_forced_closes = 0
        self.total_taker_entries = 0
        self.total_no_signal_windows = 0
        self.total_illiquid_skips = 0
        self.total_rsi_flags = 0
        self.total_signal_skips = 0
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

    def reset_for_window(self, window: WindowMarket):
        self.s = EngineState(window=window)
        if self.capital.halted:
            self._log("HALTED", note=f"engine halted (balance ${self.capital.balance:.2f} < $0) -- no trading")
            return
        self._log("WINDOW_OPEN", note=(
            f"multi-timeframe predictor ready ({self.ai.n_trained} walk-forward/live training windows); "
            f"uses 1d + 4h + 1h + 15m indicators, then buys the predicted side. "
            f"Signal threshold: confidence >= {config.AI_MIN_CONFIDENCE:.2f}, "
            f"alignment >= {config.AI_MIN_ALIGNMENT:.2f}. "
            f"wait {config.ENTRY_DELAY_SECONDS:.0f}s after window open, then immediate "
            f"taker buy of the predicted side for {config.ORDER_SHARES:.0f}sh."
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

        if self.s.position is not None:
            self._check_exit(now)
            return

        if not self.s.decision_made:
            self._check_signal(now)
        if self.s.position is None and self.s.ai_tradeable and not self.s.entry_attempted:
            self._check_taker_entry(now)

    # ---- price/level lookups ----------------------------------------------

    def _ask_for(self, side: Side) -> Optional[float]:
        return self.s.up_ask if side == Side.UP else self.s.down_ask

    def _bid_for(self, side: Side) -> Optional[float]:
        return self.s.up_bid if side == Side.UP else self.s.down_bid

    def _bid_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_bid_levels if side == Side.UP else self.s.down_bid_levels

    def _ask_levels_for(self, side: Side) -> Optional[list]:
        return self.s.up_ask_levels if side == Side.UP else self.s.down_ask_levels

    # ---- signal: multi-timeframe prediction off the Binance feed -------------

    def _check_signal(self, now: float):
        signal_open_ts = self.s.window.open_ts - 60
        candle = self.binance_feed.get_candle(signal_open_ts)
        feats = self.ai.compute_features(self.binance_feed, signal_open_ts)
        self.s.ai_features = feats
        self.s.decision_made = True
        if feats is None:
            self.total_no_signal_windows += 1
            self._log("NO_TRADE", note=(
                "multi-timeframe engine missing a complete 1d/4h/1h/15m history set "
                "(startup/reconnect/data gap)"))
            return
        side, confidence = self.ai.predict(feats)
        self.s.ai_predicted_side = side
        self.s.ai_confidence = confidence
        self.s.ai_reason = feats.reason
        self.s.ai_tradeable = self.ai.is_tradeable(confidence, feats)
        prediction = self.ai.last_prediction or {}
        self._log("AI_SIGNAL", side=side.value, price=candle.close if candle else None,
                   note=(
                       f"predicts {side.value} with confidence {confidence:.2f}; "
                       f"{feats.reason}; model p(UP)={prediction.get('p_up')}; "
                       f"historical setup accuracy is tracked by regime/hour/setup"
                   ))
        if not self.s.ai_tradeable:
            self.total_signal_skips += 1
            self._log("NO_TRADE", side=side.value, note=(
                f"signal skipped: confidence {confidence:.2f} / alignment "
                f"{feats.alignment:.2f} did not clear thresholds "
                f"({config.AI_MIN_CONFIDENCE:.2f} / {config.AI_MIN_ALIGNMENT:.2f})"
            ))
            return

    def _check_taker_entry(self, now: float):
        """Buy the predicted side once, two seconds after window open."""
        if self.s.ai_predicted_side is None or self.s.position is not None:
            return
        ready_ts = self.s.window.open_ts + config.ENTRY_DELAY_SECONDS
        if now < ready_ts:
            if not self.s.entry_wait_logged:
                self.s.entry_wait_logged = True
                self._log("ENTRY_WAIT", side=self.s.ai_predicted_side.value,
                           note=(f"signal accepted; waiting {ready_ts - now:.1f}s until "
                                 f"the {config.ENTRY_DELAY_SECONDS:.0f}s post-open taker entry"))
            return
        self.s.entry_attempted = True
        side = self.s.ai_predicted_side
        ask = self._ask_for(side)
        levels = self._ask_levels_for(side)
        fill_price = _realistic_fill_price(levels, config.ORDER_SHARES, ask)
        if fill_price is None:
            self.total_illiquid_skips += 1
            self._log("NO_TRADE", side=side.value, price=ask,
                       note="taker entry reached 2s after open, but the predicted side had no ask depth")
            return
        fee = self.broker.taker_fee_amount(config.ORDER_SHARES, fill_price)
        cost = config.ORDER_SHARES * fill_price + fee
        self.capital.balance -= cost
        self.total_taker_entries += 1
        self.total_orders_placed += 1
        self.total_order_fills += 1
        self._log("TAKER_ENTRY", side=side.value, price=fill_price, shares=config.ORDER_SHARES, fee=fee,
                   note=(f"immediate taker buy {side.value} at {config.ENTRY_DELAY_SECONDS:.0f}s "
                         f"after window open; fill {fill_price:.4f} from ask depth "
                         f"(best ask {ask}), fee ${fee:.4f}, total cost ${cost:.4f}; "
                         f"{self.s.ai_reason}"))
        if self.capital.check_halt():
            self._log("HALTED", note=f"balance ${self.capital.balance:.2f} < $0 -- bankrupt")
            return
        self.s.position = Position(side=side, entry_price=fill_price, shares=config.ORDER_SHARES, cost=cost,
                                   entry_ts=now, signal_side=side, entry_type="taker")

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
                         f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
        self.capital.check_halt()
        self.s.position = None

    # ---- window close -------------------------------------------------------

    def finalize_window(self, winning_side: Optional[Side]):
        if self.s.window is None:
            return
        window_slug = self.s.window.slug

        # One walk-forward learning step per completed window, whether or not
        # the signal cleared the live trading threshold.
        if self.s.ai_features is not None and winning_side is not None:
            actual_up = (winning_side == Side.UP)
            self.ai.learn(self.s.ai_features, actual_up)
            self.ai.record_prediction_result(self.s.ai_predicted_side, actual_up)
            self._log("AI_LEARN", note=(
                f"window resolved {winning_side.value} -- directional engine trained "
                f"on this setup (n_trained now {self.ai.n_trained})"))

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
                                 f"(entry {pos.entry_price}, fee ${fee:.4f}, pnl ${pnl:.4f})"))
                self.capital.check_halt()
                self.s.position = None
            elif self.s.ai_tradeable and not self.s.entry_attempted:
                self._log("NO_TRADE", side=(
                    self.s.ai_predicted_side.value if self.s.ai_predicted_side else None
                ), note="window closed before the 2-second taker entry could be attempted")
            elif not self.s.decision_made:
                self.total_no_signal_windows += 1
                self._log("NO_TRADE", note="multi-timeframe signal was not available before window close")

        self.s.window = None
        self.capital.record_equity_point(window_slug)

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
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
                "seconds_since_entry": round(time.time() - pos.entry_ts, 1),
                "signal_side": pos.signal_side.value if pos.signal_side else None,
                "entry_type": pos.entry_type,
            }

        if self.capital.halted:
            status = "halted"
        elif pos is not None:
            status = "open"
        elif self.s.ai_tradeable and not self.s.entry_attempted:
            status = "waiting_entry"
        elif self.s.decision_made:
            status = "done"
        else:
            status = "awaiting_signal"

        win_rate = round(100 * self.wins / (self.wins + self.losses), 1) if (self.wins + self.losses) else None

        return {
            "engine": "PREVCANDLE", "label": "Multi-timeframe directional signal",

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
            "order": None,
            "decision_made": self.s.decision_made,
            "decided_color": self.s.decided_color,
            "ai_predicted_side": self.s.ai_predicted_side.value if self.s.ai_predicted_side else None,
            "ai_confidence": round(self.s.ai_confidence, 3) if self.s.ai_confidence is not None else None,
            "ai_reason": self.s.ai_reason,
            "ai_tradeable": self.s.ai_tradeable,
            "ai_timeframes": (
                (self.ai.last_prediction or {}).get("timeframes")
                if self.ai.last_prediction else None
            ),
            "ai": self.ai.status(),
            "binance": self.binance_feed.status(),

            "total_orders_placed": self.total_orders_placed,
            "total_order_fills": self.total_order_fills,
            "total_tp_fills": self.total_tp_fills,
            "total_forced_closes": self.total_forced_closes,
            "total_taker_entries": self.total_taker_entries,
            "total_no_signal_windows": self.total_no_signal_windows,
            "total_illiquid_skips": self.total_illiquid_skips,
            "total_rsi_flags": self.total_rsi_flags,
            "total_signal_skips": self.total_signal_skips,

            "wins": self.wins,
            "losses": self.losses,
            "win_rate": win_rate,

            "status": status,

            "def": {
                "shares": config.ORDER_SHARES,
                "fade_signal": False,
                "direction": "same_as_signal",
                "entry_delay_s": config.ENTRY_DELAY_SECONDS,
                "tp_price": config.TP_PRICE,
                "min_confidence": config.AI_MIN_CONFIDENCE,
                "min_alignment": config.AI_MIN_ALIGNMENT,
            },
        }
