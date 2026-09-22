"""Async CLOB polling loop for the BTC 5-minute binary bot."""
import asyncio
import time
from collections import deque
from typing import Optional

from . import config
from .engine import Engine
from .models import PricePoint, Side, WindowMarket
from .paper_broker import PaperBroker
from .polymarket_client import PolymarketClient


class BotState:
    def __init__(self):
        self.broker = PaperBroker()
        self.engine = Engine(self.broker)
        self.client = PolymarketClient()
        self.current_window: Optional[WindowMarket] = None
        self.price_history: deque = deque(maxlen=config.WINDOW_SECONDS)
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None
        self.final_second_up: Optional[float] = None
        self.final_second_down: Optional[float] = None
        self.status = "starting"
        self.error: Optional[str] = None
        self._task: Optional[asyncio.Task] = None

    async def start(self):
        self._task = asyncio.create_task(self._run_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
        await self.client.close()

    async def _run_loop(self):
        self.status = "running"
        loop = asyncio.get_running_loop()
        while True:
            started = loop.time()
            try:
                await self._tick()
            except Exception as exc:
                self.error = f"{type(exc).__name__}: {exc}"
            await asyncio.sleep(max(0.0, config.POLL_INTERVAL_SECONDS - (loop.time() - started)))

    async def _tick(self):
        now = time.time()
        window, reason = await self.client.get_active_window(now)
        if window is None:
            self.error = reason or "no active BTC 5-minute market"
            return
        self.error = None

        if self.current_window is None or window.slug != self.current_window.slug:
            self._roll_window(window, now)

        up_book, down_book = await asyncio.gather(
            self.client.get_book_full(self.current_window.token_up),
            self.client.get_book_full(self.current_window.token_down),
        )
        self.last_up_bid = up_book["best_bid"] if up_book else None
        self.last_up_ask = up_book["best_ask"] if up_book else None
        self.last_down_bid = down_book["best_bid"] if down_book else None
        self.last_down_ask = down_book["best_ask"] if down_book else None

        up_mid = self._midpoint(self.last_up_bid, self.last_up_ask)
        down_mid = self._midpoint(self.last_down_bid, self.last_down_ask)
        self.price_history.append(PricePoint(ts=now, up=up_mid, down=down_mid))

        seconds_to_close = self.current_window.close_ts - now
        if 0 < seconds_to_close <= config.FINAL_SECOND_SECONDS:
            # Last-trade-price is the CLOB settlement signal; midpoint is a
            # fallback for a temporarily unavailable last-trade endpoint.
            up_price, down_price = await asyncio.gather(
                self.client.get_price(self.current_window.token_up),
                self.client.get_price(self.current_window.token_down),
            )
            self.final_second_up = up_price if up_price is not None else up_mid
            self.final_second_down = down_price if down_price is not None else down_mid

        self.engine.on_tick(
            self.last_up_bid,
            self.last_up_ask,
            self.last_down_bid,
            self.last_down_ask,
            seconds_to_close,
            now=now,
            up_bid_levels=up_book["bids"] if up_book else None,
            up_ask_levels=up_book["asks"] if up_book else None,
            down_bid_levels=down_book["bids"] if down_book else None,
            down_ask_levels=down_book["asks"] if down_book else None,
        )

    def _roll_window(self, new_window: WindowMarket, now: float):
        previous_winner = None
        if self.current_window is not None:
            previous_winner = self._resolve_final_winner()
            self.engine.finalize_window(previous_winner)

        first_window = self.current_window is None
        self.current_window = new_window
        self.price_history.clear()
        self.last_up_bid = self.last_up_ask = None
        self.last_down_bid = self.last_down_ask = None
        self.final_second_up = self.final_second_down = None
        late_join = first_window and now - new_window.open_ts > config.LATE_JOIN_GRACE_SECONDS
        self.engine.reset_for_window(new_window, previous_winner, late_join=late_join)

    def _resolve_final_winner(self) -> Optional[Side]:
        up = self.final_second_up
        down = self.final_second_down
        threshold = config.WINNER_THRESHOLD
        if up is None or down is None:
            return None
        up_wins = up >= threshold
        down_wins = down >= threshold
        if up_wins and not down_wins:
            return Side.UP
        if down_wins and not up_wins:
            return Side.DOWN
        if up_wins and down_wins:
            if up > down:
                return Side.UP
            if down > up:
                return Side.DOWN
        return None

    @staticmethod
    def _midpoint(bid, ask):
        if bid is not None and ask is not None:
            return (bid + ask) / 2
        return ask if ask is not None else bid

    def snapshot(self) -> dict:
        eng = self.engine.snapshot()
        return {
            "status": self.status,
            "error": self.error,
            "server_time": time.time(),
            "window": (
                {
                    "slug": self.current_window.slug,
                    "open_ts": self.current_window.open_ts,
                    "close_ts": self.current_window.close_ts,
                }
                if self.current_window
                else None
            ),
            "book": {
                "up_bid": self.last_up_bid,
                "up_ask": self.last_up_ask,
                "down_bid": self.last_down_bid,
                "down_ask": self.last_down_ask,
            },
            "prices": {
                "up": self._midpoint(self.last_up_bid, self.last_up_ask),
                "down": self._midpoint(self.last_down_bid, self.last_down_ask),
            },
            "final_second_prices": {
                "up": self.final_second_up,
                "down": self.final_second_down,
                "threshold": config.WINNER_THRESHOLD,
            },
            "price_history": [
                {"ts": p.ts, "up": p.up, "down": p.down}
                for p in list(self.price_history)[-120:]
            ],
            "pnl_total": round(eng["realized_pnl"], 4),
            "demo_capital": {
                "balance": eng["balance"],
                "starting_capital": eng["starting_capital"],
                "halted": eng["halted"],
            },
            "engine": eng,
            "log": [
                {
                    "ts": e.ts,
                    "engine": e.engine,
                    "window": e.window_slug,
                    "event": e.event,
                    "side": e.side,
                    "price": e.price,
                    "shares": e.shares,
                    "maker_rebate": e.maker_rebate,
                    "pnl": e.pnl,
                    "balance_after": e.balance_after,
                    "note": e.note,
                }
                for e in reversed(self.broker.log[-100:])
            ],
        }