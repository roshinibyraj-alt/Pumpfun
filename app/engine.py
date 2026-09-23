from __future__ import annotations
import asyncio
import logging
import time
from typing import Optional

from . import config
from .models import RungState, RungOrders, SimOrder, Side, OrderStatus, Outcome, WindowState
from .polymarket_client import PolymarketClient, window_start_for, slug_for_window

log = logging.getLogger("engine")


class Engine:
    def __init__(self):
        self.client = PolymarketClient()
        self.rungs: dict[float, RungState] = {p: RungState(price=p) for p in config.RUNG_PRICES}
        self.active_windows: dict[str, WindowState] = {}
        self.window_history: list[dict] = []   # archived, settled windows (light dicts)
        self._token_cache: dict[str, tuple[str, str]] = {}   # slug -> (up, down)
        self.events_log: list[dict] = []
        self._subscribers: list[asyncio.Queue] = []
        self.started_at = time.time()

    # ---- pub/sub for the websocket layer -----------------------------
    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue(maxsize=4)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    def _log_event(self, text: str, level: str = "info"):
        entry = {"ts": time.time(), "text": text, "level": level}
        self.events_log.append(entry)
        if len(self.events_log) > 200:
            self.events_log.pop(0)
        log.info(text)

    async def _broadcast(self):
        snap = self.snapshot()
        dead = []
        for q in self._subscribers:
            if q.full():
                try:
                    q.get_nowait()
                except Exception:
                    pass
            try:
                q.put_nowait(snap)
            except Exception:
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    # ---- main loop -----------------------------------------------------
    async def run_forever(self):
        self._log_event("Engine started — paper trading mode, no real orders will be sent.")
        while True:
            try:
                await self._tick()
            except Exception as e:
                log.exception("tick failed: %s", e)
                self._log_event(f"tick error: {e}", level="error")
            await asyncio.sleep(config.TICK_SECONDS)

    async def _tick(self):
        now = time.time()
        cur_start = window_start_for(now)
        cur_slug = slug_for_window(cur_start)
        next_slug = slug_for_window(cur_start + config.WINDOW_SECONDS)

        # Prefetch the next window's token ids shortly before it opens
        secs_into_current = now - cur_start
        if secs_into_current >= config.WINDOW_SECONDS - config.PREFETCH_LEAD_SECONDS:
            await self._ensure_tokens_cached(next_slug)

        await self._ensure_tokens_cached(cur_slug)

        # Open the current window if we haven't yet and we have its tokens
        if cur_slug not in self.active_windows and cur_slug in self._token_cache:
            up_id, down_id = self._token_cache[cur_slug]
            ws = WindowState(
                slug=cur_slug,
                start_ts=cur_start,
                end_ts=cur_start + config.WINDOW_SECONDS,
                up_token_id=up_id,
                down_token_id=down_id,
            )
            self.active_windows[cur_slug] = ws
            self._log_event(f"Window {cur_slug} opened — placing rung orders.")

        # Process every active window
        for slug in list(self.active_windows.keys()):
            ws = self.active_windows[slug]
            await self._process_window(ws, now)
            if ws.settled and now > ws.end_ts + config.WINDOW_ARCHIVE_DELAY:
                self.window_history.append(self._archive_dict(ws))
                if len(self.window_history) > 100:
                    self.window_history.pop(0)
                del self.active_windows[slug]

        await self._broadcast()

    async def _ensure_tokens_cached(self, slug: str):
        if slug in self._token_cache:
            return
        tokens = await self.client.get_up_down_token_ids(slug)
        if tokens:
            self._token_cache[slug] = tokens
            self._log_event(f"Discovered market {slug}.")
        # prune cache so it doesn't grow forever
        if len(self._token_cache) > 20:
            oldest = sorted(self._token_cache.keys())[0]
            self._token_cache.pop(oldest, None)

    async def _process_window(self, ws: WindowState, now: float):
        elapsed = now - ws.start_ts

        # Place resting orders exactly once, at window open, sized per rung's
        # *current* independent state.
        if not ws.orders_placed:
            for price, rung in self.rungs.items():
                ws.rungs[price] = RungOrders(
                    up=SimOrder(side=Side.UP, price=price, size=rung.current_size),
                    down=SimOrder(side=Side.DOWN, price=price, size=rung.current_size),
                )
            ws.orders_placed = True

        if ws.settled:
            return

        # Fetch live prices (best ask, i.e. price to buy) for both legs
        up_price = await self.client.get_price(ws.up_token_id, side="buy")
        down_price = await self.client.get_price(ws.down_token_id, side="buy")
        if up_price is not None:
            ws.last_up_price = up_price
        if down_price is not None:
            ws.last_down_price = down_price

        # --- fill simulation, per rung, independent ---------------------
        if elapsed < config.ORDER_CUTOFF_SECONDS:
            for price, ro in ws.rungs.items():
                if ro.filled_side is not None:
                    continue  # already resolved this rung for this window
                up_ask = ws.last_up_price
                down_ask = ws.last_down_price
                if ro.up.status == OrderStatus.PENDING and up_ask is not None and up_ask <= price:
                    ro.up.status = OrderStatus.FILLED
                    ro.up.fill_price = price
                    ro.up.filled_at = now
                    ro.filled_side = Side.UP
                    if ro.down.status == OrderStatus.PENDING:
                        ro.down.status = OrderStatus.CANCELLED
                    self._log_event(
                        f"[{ws.slug}] rung {price:.2f} UP filled @ {price:.2f} "
                        f"({self.rungs[price].current_size} sh) — DOWN order cancelled."
                    )
                elif ro.down.status == OrderStatus.PENDING and down_ask is not None and down_ask <= price:
                    ro.down.status = OrderStatus.FILLED
                    ro.down.fill_price = price
                    ro.down.filled_at = now
                    ro.filled_side = Side.DOWN
                    if ro.up.status == OrderStatus.PENDING:
                        ro.up.status = OrderStatus.CANCELLED
                    self._log_event(
                        f"[{ws.slug}] rung {price:.2f} DOWN filled @ {price:.2f} "
                        f"({self.rungs[price].current_size} sh) — UP order cancelled."
                    )

        # --- cutoff: no trades after 270s -------------------------------
        if elapsed >= config.ORDER_CUTOFF_SECONDS:
            for price, ro in ws.rungs.items():
                if ro.cutoff_applied:
                    continue
                if ro.up.status == OrderStatus.PENDING:
                    ro.up.status = OrderStatus.CANCELLED
                if ro.down.status == OrderStatus.PENDING:
                    ro.down.status = OrderStatus.CANCELLED
                ro.cutoff_applied = True

        # --- settlement: last two seconds of the window -----------------
        settle_at = ws.end_ts - config.WIN_CHECK_SECONDS_BEFORE_CLOSE
        if now >= settle_at and not ws.settled:
            up_p = ws.last_up_price if ws.last_up_price is not None else 0.0
            down_p = ws.last_down_price if ws.last_down_price is not None else 0.0
            if up_p > config.WIN_PRICE_THRESHOLD and down_p <= config.WIN_PRICE_THRESHOLD:
                winner = Side.UP
            elif down_p > config.WIN_PRICE_THRESHOLD and up_p <= config.WIN_PRICE_THRESHOLD:
                winner = Side.DOWN
            else:
                # neither (or both, edge case) crossed 0.95 — higher price wins
                winner = Side.UP if up_p >= down_p else Side.DOWN
            ws.winner = winner

            for price, ro in ws.rungs.items():
                rung = self.rungs[price]
                size_used = ro.up.size if ro.filled_side == Side.UP else (
                    ro.down.size if ro.filled_side == Side.DOWN else rung.current_size
                )
                if ro.filled_side is None:
                    outcome = Outcome.NO_FILL
                elif ro.filled_side == winner:
                    outcome = Outcome.WIN
                else:
                    outcome = Outcome.LOSS
                rung.record_fill_outcome(ws.slug, ro.filled_side, size_used, outcome, now)
                ro.settled = True

            ws.settled = True
            self._log_event(
                f"[{ws.slug}] SETTLED — winner {winner.value} "
                f"(UP {up_p:.3f} / DOWN {down_p:.3f})"
            )

    def _archive_dict(self, ws: WindowState) -> dict:
        d = ws.to_dict()
        return d

    # ---- snapshot for dashboard -----------------------------------------
    def snapshot(self) -> dict:
        now = time.time()
        cur_start = window_start_for(now)
        cur_slug = slug_for_window(cur_start)
        elapsed = now - cur_start
        cutoff_remaining = max(0.0, config.ORDER_CUTOFF_SECONDS - elapsed)
        window_remaining = max(0.0, config.WINDOW_SECONDS - elapsed)

        total_pnl = sum(r.total_pnl for r in self.rungs.values())
        total_trades = sum(r.total_trades for r in self.rungs.values())
        total_wins = sum(r.wins for r in self.rungs.values())
        total_capital = sum(r.capital_balance for r in self.rungs.values())
        total_start_capital = sum(r.capital_start for r in self.rungs.values())

        recent_trades = []
        for rung in self.rungs.values():
            recent_trades.extend(rung.history[-25:])
        recent_trades.sort(key=lambda t: t.settled_at, reverse=True)
        recent_trades = recent_trades[:40]

        return {
            "server_time": now,
            "mode": "PAPER TRADING",
            "current_window": {
                "slug": cur_slug,
                "elapsed": round(elapsed, 1),
                "cutoff_remaining": round(cutoff_remaining, 1),
                "window_remaining": round(window_remaining, 1),
                "past_cutoff": elapsed >= config.ORDER_CUTOFF_SECONDS,
            },
            "config": {
                "rung_prices": config.RUNG_PRICES,
                "base_size": config.BASE_SIZE,
                "size_step": config.SIZE_STEP,
                "floor_size": config.FLOOR_SIZE,
                "capital_per_rung": config.CAPITAL_PER_RUNG,
                "order_cutoff_seconds": config.ORDER_CUTOFF_SECONDS,
                "window_seconds": config.WINDOW_SECONDS,
            },
            "aggregate": {
                "total_pnl": round(total_pnl, 2),
                "total_trades": total_trades,
                "total_wins": total_wins,
                "win_rate": round((total_wins / total_trades * 100) if total_trades else 0.0, 1),
                "total_capital": round(total_capital, 2),
                "total_start_capital": total_start_capital,
                "roi_pct": round(((total_capital - total_start_capital) / total_start_capital * 100)
                                  if total_start_capital else 0.0, 2),
            },
            "rungs": [self.rungs[p].to_dict() for p in config.RUNG_PRICES],
            "active_windows": [w.to_dict() for w in self.active_windows.values()],
            "recent_trades": [t.to_dict() for t in recent_trades],
            "events": self.events_log[-30:],
            "uptime_seconds": round(now - self.started_at),
        }
