from __future__ import annotations
import asyncio
import logging
import time
from typing import Optional

from . import config
from .models import CopiedPosition, CopyTradeRecord, Side, TradeNote, next_trade_id
from .data_client import DataClient

log = logging.getLogger("engine")


class CopyEngine:
    def __init__(self):
        self.client = DataClient()
        self.master_wallet = config.MASTER_WALLET

        self.positions: dict[str, CopiedPosition] = {}     # token_id -> position
        self.trade_log: list[CopyTradeRecord] = []
        self.seen_trade_keys: set[str] = set()
        self.last_seen_ts: float = 0.0

        # capped demo ledger — this is the actual $10,000 paper account
        self.cash_balance: float = config.DEMO_CAPITAL
        self.realized_pnl: float = 0.0
        self.peak_capital_deployed: float = 0.0   # high-water mark of capped capital in use

        # uncapped shadow ledger — answers "how much capital would I actually need"
        self.ideal_deployed: float = 0.0
        self.ideal_peak_deployed: float = 0.0
        self.ideal_max_trade_cost: Optional[float] = None
        self.ideal_min_trade_cost: Optional[float] = None

        self.bootstrapped = False
        self.master_stats: Optional[dict] = None
        self.events_log: list[dict] = []
        self._subscribers: list[asyncio.Queue] = []
        self.started_at = time.time()
        self._last_stats_fetch = 0.0

    # ---- pub/sub ---------------------------------------------------------
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

    # ---- capital bookkeeping helpers -------------------------------------
    def _capital_deployed(self) -> float:
        return sum(p.cost_basis for p in self.positions.values() if p.our_size > 0)

    def _touch_peak(self):
        deployed = self._capital_deployed()
        if deployed > self.peak_capital_deployed:
            self.peak_capital_deployed = deployed

    def _touch_ideal_peak(self):
        if self.ideal_deployed > self.ideal_peak_deployed:
            self.ideal_peak_deployed = self.ideal_deployed

    def _get_or_create_position(self, row: dict) -> CopiedPosition:
        pos = self.positions.get(row["token_id"])
        if pos is None:
            pos = CopiedPosition(
                token_id=row["token_id"],
                condition_id=row.get("condition_id", ""),
                market_title=row.get("market_title", "Unknown market"),
                outcome_label=row.get("outcome_label", "?"),
                slug=row.get("slug", ""),
                icon=row.get("icon", ""),
            )
            self.positions[row["token_id"]] = pos
        return pos

    # ---- main loop -----------------------------------------------------
    async def run_forever(self):
        self._log_event(
            f"Copy-trading demo bot started. Master wallet {self.master_wallet}, "
            f"copy ratio {config.COPY_RATIO*100:.0f}%, demo capital ${config.DEMO_CAPITAL:,.0f}."
        )
        while True:
            try:
                if not self.bootstrapped:
                    await self._initialize()
                else:
                    await self._poll_new_trades()
                await self._refresh_prices()
                await self._maybe_refresh_stats()
            except Exception as e:
                log.exception("tick failed: %s", e)
                self._log_event(f"tick error: {e}", level="error")
            await self._broadcast()
            await asyncio.sleep(config.TRADE_POLL_SECONDS)

    # ---- initialize: copy NOTHING the master already holds ----------------
    # By design this bot only mirrors trades placed from the moment it starts
    # onward. Whatever the master already had open before that is ignored —
    # we still fetch their recent trade history, but purely to mark it as
    # "already seen" so the live poller never replays it as a new signal.
    async def _initialize(self):
        self._log_event(
            f"Initializing — this bot only copies NEW trades placed by "
            f"{self.master_wallet} from this point forward. Existing open "
            f"positions are intentionally NOT copied."
        )
        recent = await self.client.get_recent_trades(self.master_wallet, limit=config.STARTUP_TRADE_LOOKBACK)
        for t in recent:
            self.seen_trade_keys.add(t["key"])
            if t["timestamp"] > self.last_seen_ts:
                self.last_seen_ts = t["timestamp"]

        self.bootstrapped = True
        self._log_event("Ready — watching the master wallet for new trades.")

    # ---- live loop: copy every new fill from the master -------------------
    async def _poll_new_trades(self):
        trades = await self.client.get_recent_trades(self.master_wallet, limit=50)
        new_trades = [t for t in trades if t["key"] not in self.seen_trade_keys]
        if not new_trades:
            return
        # oldest first, so a burst of fills is copied in the order they happened
        new_trades.sort(key=lambda t: t["timestamp"])

        for t in new_trades:
            self.seen_trade_keys.add(t["key"])
            self.last_seen_ts = max(self.last_seen_ts, t["timestamp"])
            await self._copy_trade(t)

    async def _copy_trade(self, t: dict):
        side = Side.BUY if t["side"] == "BUY" else Side.SELL
        price = t["price"]
        master_size = t["size"]
        copy_size = master_size * config.COPY_RATIO
        ideal_cost = copy_size * price

        pos = self._get_or_create_position(t)
        pos.master_size_at_last_sync += master_size if side == Side.BUY else -master_size

        if side == Side.BUY:
            self._record_ideal_buy_signal(ideal_cost)
            demo_size, demo_cost, note = self._apply_capped_buy(copy_size, price)
            self._add_to_position(pos, demo_size, price)
            realized = 0.0
        else:
            self.ideal_deployed = max(0.0, self.ideal_deployed - ideal_cost)
            demo_size, demo_cost, realized, note = self._apply_capped_sell(pos, copy_size, price)

        rec = CopyTradeRecord(
            id=next_trade_id(), timestamp=time.time(), token_id=t["token_id"],
            market_title=t["market_title"], outcome_label=t["outcome_label"],
            side=side, note=note,
            master_trade_size=master_size, ideal_copy_size=copy_size, ideal_cost=ideal_cost,
            demo_copy_size=demo_size, demo_cost=demo_cost, price=price,
            cash_after=self.cash_balance, realized_pnl=realized,
        )
        self._push_trade(rec)
        self._touch_peak()
        self._touch_ideal_peak()

        tag = "BUY" if side == Side.BUY else "SELL"
        self._log_event(
            f"Master {tag} {master_size:.2f} sh of {t['market_title']} ({t['outcome_label']}) "
            f"@ {price:.3f} — copied {demo_size:.2f} sh ({note.value})."
        )

    # ---- capped (demo) execution helpers -----------------------------------
    def _apply_capped_buy(self, copy_size: float, price: float) -> tuple[float, float, TradeNote]:
        full_cost = copy_size * price
        if full_cost <= self.cash_balance:
            self.cash_balance -= full_cost
            return copy_size, full_cost, TradeNote.LIVE_COPY
        if self.cash_balance > 0:
            size = self.cash_balance / price
            cost = self.cash_balance
            self.cash_balance = 0.0
            return size, cost, TradeNote.PARTIAL_FILL
        return 0.0, 0.0, TradeNote.SKIPPED

    def _apply_capped_sell(self, pos: CopiedPosition, copy_size: float, price: float
                            ) -> tuple[float, float, float, TradeNote]:
        sell_size = min(copy_size, pos.our_size)
        if sell_size <= 0:
            return 0.0, 0.0, 0.0, TradeNote.SKIPPED
        proceeds = sell_size * price
        cost_removed = sell_size * pos.avg_entry_price
        realized = proceeds - cost_removed

        pos.our_size -= sell_size
        pos.cost_basis -= cost_removed
        pos.realized_pnl += realized
        if pos.our_size <= config.POSITION_DUST_SHARES:
            pos.our_size = 0.0
            pos.cost_basis = 0.0

        self.cash_balance += proceeds
        self.realized_pnl += realized
        note = TradeNote.CLOSE if pos.our_size == 0.0 else TradeNote.LIVE_COPY
        return sell_size, proceeds, realized, note

    def _add_to_position(self, pos: CopiedPosition, size: float, price: float):
        if size <= 0:
            return
        new_total_size = pos.our_size + size
        new_cost_basis = pos.cost_basis + size * price
        pos.our_size = new_total_size
        pos.cost_basis = new_cost_basis
        pos.avg_entry_price = new_cost_basis / new_total_size if new_total_size > 0 else 0.0

    def _record_ideal_buy_signal(self, ideal_cost: float):
        self.ideal_deployed += ideal_cost
        if self.ideal_max_trade_cost is None or ideal_cost > self.ideal_max_trade_cost:
            self.ideal_max_trade_cost = ideal_cost
        if self.ideal_min_trade_cost is None or ideal_cost < self.ideal_min_trade_cost:
            self.ideal_min_trade_cost = ideal_cost

    def _push_trade(self, rec: CopyTradeRecord):
        self.trade_log.append(rec)
        if len(self.trade_log) > config.MAX_TRADE_LOG:
            self.trade_log.pop(0)

    # ---- price refresh ---------------------------------------------------
    async def _refresh_prices(self):
        for pos in self.positions.values():
            if pos.our_size <= 0:
                continue
            price = await self.client.get_price(pos.token_id, side="sell")
            if price is not None:
                pos.mark_price = price

    async def _maybe_refresh_stats(self):
        now = time.time()
        if now - self._last_stats_fetch < config.STATS_REFRESH_SECONDS:
            return
        self._last_stats_fetch = now
        stats = await self.client.get_user_stats(self.master_wallet)
        if stats:
            self.master_stats = stats

    # ---- snapshot for dashboard -------------------------------------------
    def snapshot(self) -> dict:
        now = time.time()
        open_positions = [p for p in self.positions.values() if p.our_size > 0]
        capital_deployed = self._capital_deployed()
        total_equity = self.cash_balance + capital_deployed
        unrealized = sum(p.unrealized_pnl for p in open_positions)
        combined_pnl = self.realized_pnl + unrealized
        roi_pct = (combined_pnl / config.DEMO_CAPITAL * 100) if config.DEMO_CAPITAL else 0.0

        trade_costs = [t.ideal_cost for t in self.trade_log if t.side == Side.BUY and t.ideal_cost > 0]

        capital_shortfall = max(0.0, self.ideal_peak_deployed - config.DEMO_CAPITAL)

        return {
            "server_time": now,
            "mode": "COPY TRADING — DEMO",
            "master_wallet": self.master_wallet,
            "master_stats": self.master_stats,
            "config": {
                "copy_ratio": config.COPY_RATIO,
                "demo_capital": config.DEMO_CAPITAL,
            },
            "ledger": {
                "cash_balance": round(self.cash_balance, 2),
                "capital_deployed": round(capital_deployed, 2),
                "total_equity": round(total_equity, 2),
                "peak_capital_deployed": round(self.peak_capital_deployed, 2),
                "realized_pnl": round(self.realized_pnl, 2),
                "unrealized_pnl": round(unrealized, 2),
                "combined_pnl": round(combined_pnl, 2),
                "roi_pct": round(roi_pct, 2),
            },
            "capital_required": {
                "ideal_peak_deployed": round(self.ideal_peak_deployed, 2),
                "ideal_deployed_now": round(self.ideal_deployed, 2),
                "shortfall_vs_demo": round(capital_shortfall, 2),
                "sufficiently_capitalized": capital_shortfall <= 0.0,
                "max_trade_cost": round(self.ideal_max_trade_cost, 2) if self.ideal_max_trade_cost is not None else None,
                "min_trade_cost": round(self.ideal_min_trade_cost, 2) if self.ideal_min_trade_cost is not None else None,
                "avg_trade_cost": round(sum(trade_costs) / len(trade_costs), 2) if trade_costs else None,
                "total_buy_signals": len(trade_costs),
            },
            "positions": [p.to_dict() for p in sorted(open_positions, key=lambda p: p.current_value, reverse=True)],
            "recent_trades": [t.to_dict() for t in self.trade_log[-60:][::-1]],
            "events": self.events_log[-30:],
            "bootstrapped": self.bootstrapped,
            "uptime_seconds": round(now - self.started_at),
        }
