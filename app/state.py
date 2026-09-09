"""Shared runtime state + the background loop that drives the engine."""
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
        self.price_history: deque = deque(maxlen=300)  # ~5 min at 1s ticks
        self.last_up_price: Optional[float] = None
        self.last_down_price: Optional[float] = None
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
        while True:
            try:
                await self._tick()
            except Exception as e:  # keep the loop alive no matter what
                self.error = str(e)
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def _tick(self):
        now = time.time()
        window = await self.client.get_active_window(now)
        if window is None:
            self.error = "No market found for current window slug"
            return
        self.error = None

        if self.current_window is None or window.slug != self.current_window.slug:
            await self._roll_window(window)

        up_price = await self.client.get_price(self.current_window.token_up)
        down_price = await self.client.get_price(self.current_window.token_down)
        self.last_up_price, self.last_down_price = up_price, down_price
        self.price_history.append(PricePoint(ts=now, up=up_price, down=down_price))

        seconds_to_close = self.current_window.close_ts - now
        self.engine.on_tick(up_price, down_price, seconds_to_close, now=now)

    async def _roll_window(self, new_window: WindowMarket):
        # Finalize the previous window before starting the new one.
        if self.current_window is not None:
            winning_side = self._infer_winner()
            self.broker.log_event(
                "SYS", self.current_window.slug, "SETTLED_BY_PRICE",
                side=winning_side.value if winning_side else None,
                note=(f"settled by last observed CLOB price: up={self.last_up_price}, "
                      f"down={self.last_down_price} (no Polymarket resolution check)"),
            )
            self.engine.finalize_window(winning_side)

        self.current_window = new_window
        self.price_history.clear()
        self.engine.reset_for_window(new_window)

    def _infer_winner(self) -> Optional[Side]:
        """The sole outcome source: whichever side's last observed CLOB
        price (up to POLL_INTERVAL_SECONDS stale) was higher when the
        window rolled over. This is a live-market read, not Polymarket's
        settled resolution -- it can occasionally disagree with the real
        outcome if the last tick was noisy or a beat late. Traded off
        deliberately for simplicity/determinism over that small accuracy
        gap; see fetch_resolution() in polymarket_client.py if you want
        to reintroduce real-resolution settlement later."""
        if self.last_up_price is None or self.last_down_price is None:
            return None
        return Side.UP if self.last_up_price >= self.last_down_price else Side.DOWN

    # ---- dashboard payload -------------------------------------------------

    def snapshot(self) -> dict:
        eng = self.engine.snapshot()
        return {
            "status": self.status,
            "error": self.error,
            "server_time": time.time(),
            "window": None if not self.current_window else {
                "slug": self.current_window.slug,
                "open_ts": self.current_window.open_ts,
                "close_ts": self.current_window.close_ts,
            },
            "prices": {
                "up": self.last_up_price,
                "down": self.last_down_price,
            },
            "price_history": [
                {"ts": p.ts, "up": p.up, "down": p.down}
                for p in list(self.price_history)[-120:]
            ],
            "pnl_total": round(eng["total_pnl"], 2),
            # Demo capital: this is the single balance the whole app
            # tracks -- see engine.py / config.STARTING_CAPITAL. Exposed
            # at the top level too so the dashboard can feature it
            # prominently without digging into the engine block.
            "demo_capital": {
                "balance": eng["balance"],
                "starting_capital": eng["starting_capital"],
                "halted": eng["halted"],
            },
            "engine": eng,
            "log": [
                {
                    "ts": e.ts, "engine": e.engine, "window": e.window_slug,
                    "event": e.event, "side": e.side, "price": e.price,
                    "shares": e.shares, "pnl": e.pnl,
                    "balance_after": e.balance_after, "note": e.note,
                }
                for e in reversed(self.broker.log[-100:])
            ],
        }
