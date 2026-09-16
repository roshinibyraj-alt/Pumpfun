"""
Main trading loop for the 9-engine bot. All 9 engines share one BTC
5-minute window's live order books (fetched once per tick) but trade
completely independently -- separate balances, separate positions,
separate histories.

E1-E5 ("limit_cancel_skip"): resting limit buys on both sides at a fixed
price; first fill cancels the other side; TP only, no SL. After a real
win, the engine goes into "skip" mode for N windows, but keeps running
identical SHADOW trades (no real money) through those windows purely to
check whether it would have won. A shadow win resets the skip counter to
N (stays sidelined); anything else (shadow loss, or no fill at all)
decrements it by one. Reaching 0 resumes real trading next window.

E6-E9 ("taker_momentum"): whichever side's price first rises to a fixed
trigger level is bought immediately at that live price (a taker fill,
not a resting order); real stop-loss and take-profit, no skip logic.

Universal rule: hitting take-profit (0.99) is booked as a clean
$1.00/share payout with no fee -- same treatment as a winning
resolution, not an actual market sale.
"""
import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config, storage
from .clobbook import ClobClient, OrderBook
from .engine import PaperLedger, Position
from .gamma import GammaClient, MarketWindow, current_window_start


@dataclass
class EngineState:
    skip_counter: int = 0
    this_window_is_shadow: bool = False
    current_trial: Optional[Position] = None
    canceled_sides: set = field(default_factory=set)
    entered_this_window: bool = False
    awaiting_resolution: List[Position] = field(default_factory=list)
    awaiting_since: Dict[int, float] = field(default_factory=dict)
    warned_stale_ids: set = field(default_factory=set)


class NineEngineBot:
    def __init__(self):
        self.log = logging.getLogger("strategy")
        self.gamma = GammaClient(log=self.log)
        self.clob = ClobClient()

        self.window: Optional[MarketWindow] = None
        self.current_window_start: Optional[int] = None
        self.last_books: Dict[str, OrderBook] = {}

        self.ledgers: Dict[str, PaperLedger] = {}
        self.states: Dict[str, EngineState] = {}
        self.cfg_by_label = {cfg.label: cfg for cfg in config.ENGINES}
        for cfg in config.ENGINES:
            saved = storage.load_engine_state(cfg.label, config.STARTING_CAPITAL_PER_ENGINE)
            self.ledgers[cfg.label] = PaperLedger(cfg.label, saved["balance"], log=self.log)
            st = EngineState()
            st.skip_counter = saved["skip_counter"]
            st.this_window_is_shadow = st.skip_counter > 0
            self.states[cfg.label] = st

        self.tick_count = 0
        self.status_note = "starting"

    def _fee_rate(self) -> float:
        return self.window.taker_fee_rate if self.window else config.FALLBACK_TAKER_FEE_RATE

    def _apply_skip_result(self, cfg, st: EngineState, won: bool):
        old = st.skip_counter
        st.skip_counter = cfg.skip_length if won else max(0, st.skip_counter - 1)
        self.log.info("[%s] skip-check result=%s -> skip_counter %d -> %d",
                      cfg.label, "WIN" if won else "not-a-win", old, st.skip_counter)

    # ---------------------------------------------------------------- window
    async def _ensure_window(self):
        ws = current_window_start(config.WINDOW_SECONDS)
        is_new_window = self.window is not None and self.window.window_start != ws

        newly_rolled: Dict[str, Position] = {}
        if is_new_window:
            for cfg in config.ENGINES:
                st = self.states[cfg.label]
                pos = st.current_trial
                if pos is not None and pos.status == "OPEN":
                    st.awaiting_resolution.append(pos)
                    st.awaiting_since[pos.id] = time.time()
                    newly_rolled[cfg.label] = pos
                    self.log.info("[%s] window %s rolled; %s -> awaiting resolution",
                                  cfg.label, self.window.slug, pos.outcome)
                elif pos is None and cfg.kind == "limit_cancel_skip":
                    # never filled this window at all -- fully known now
                    self._apply_skip_result(cfg, st, won=False)
                st.current_trial = None
                st.canceled_sides = set()
                st.entered_this_window = False

        if self.window is None or self.window.window_start != ws:
            new_win = await self.gamma.get_window(config.ASSET, ws, config.WINDOW_SECONDS, config.WINDOW_LABEL)
            if new_win is None:
                self.log.warning("could not load %s window for %s (will retry)", config.ASSET, ws)
                return
            self.window = new_win

        # give any just-rolled position one immediate resolve attempt --
        # lets an already-knowable result apply its skip decision to the
        # TRUE next window rather than the one after (same optimization
        # used in earlier bots in this series).
        for label, pos in newly_rolled.items():
            st = self.states[label]
            try:
                done = await self._try_resolve(label, pos)
            except Exception:
                self.log.exception("[%s] immediate post-roll resolve attempt failed for position %s",
                                   label, pos.id)
                done = False
            if done:
                st.awaiting_since.pop(pos.id, None)
                st.warned_stale_ids.discard(pos.id)
                st.awaiting_resolution = [p for p in st.awaiting_resolution if p.id != pos.id]

        if is_new_window:
            for cfg in config.ENGINES:
                if cfg.kind != "limit_cancel_skip":
                    continue
                st = self.states[cfg.label]
                st.this_window_is_shadow = st.skip_counter > 0
                storage.save_engine_state(cfg.label, self.ledgers[cfg.label].balance, st.skip_counter)

        self.current_window_start = ws

    # ------------------------------------------------------------------ books
    async def _fetch_books(self) -> Dict[str, OrderBook]:
        token_ids = set()
        if self.window:
            for tok in self.window.tokens.values():
                token_ids.add(tok.token_id)
        for st in self.states.values():
            for pos in st.awaiting_resolution:
                token_ids.add(pos.token_id)

        results = await asyncio.gather(
            *[self.clob.get_book(t) for t in token_ids], return_exceptions=True
        )
        books = {}
        for tok, res in zip(token_ids, results):
            if isinstance(res, Exception):
                self.log.warning("book fetch failed for %s: %s", tok, res)
                continue
            books[tok] = res
        self.last_books.update(books)
        return books

    # -------------------------------------------------------------- one tick
    async def tick(self):
        self.tick_count += 1
        await self._ensure_window()
        if self.window is None:
            self.status_note = "waiting for market discovery"
            return

        books = await self._fetch_books()

        for cfg in config.ENGINES:
            st = self.states[cfg.label]
            ledger = self.ledgers[cfg.label]
            if cfg.kind == "limit_cancel_skip":
                self._tick_limit_cancel_skip(cfg, st, ledger, books)
            else:
                self._tick_taker_momentum(cfg, st, ledger, books)

        self.status_note = "running"

    def _tick_limit_cancel_skip(self, cfg, st: EngineState, ledger: PaperLedger, books: Dict[str, OrderBook]):
        pos = st.current_trial
        if pos is not None and pos.status == "OPEN":
            book = books.get(pos.token_id)
            if book is not None and book.best_bid is not None and book.best_bid >= config.TAKE_PROFIT_TRIGGER_PRICE:
                ledger.close_take_profit(pos)
                storage.record_position(pos)
                self._apply_skip_result(cfg, st, won=True)
                storage.save_engine_state(cfg.label, ledger.balance, st.skip_counter)
                st.current_trial = None
                st.canceled_sides = {"Up", "Down"}
            return

        for outcome in ("Up", "Down"):
            if outcome in st.canceled_sides:
                continue
            tok = self.window.tokens.get(outcome)
            if tok is None:
                continue
            book = books.get(tok.token_id)
            if book is None or book.best_ask is None:
                continue
            if book.best_ask <= cfg.price:
                new_pos = ledger.open_position(
                    self.window.window_start, outcome, tok.token_id, cfg.price,
                    self._fee_rate(), is_shadow=st.this_window_is_shadow,
                )
                st.current_trial = new_pos
                other = "Down" if outcome == "Up" else "Up"
                st.canceled_sides.add(other)
                self.log.info("[%s] %s filled first this window%s -> %s canceled",
                             cfg.label, outcome, " (SHADOW)" if new_pos.is_shadow else "", other)
                if not new_pos.is_shadow:
                    storage.save_engine_state(cfg.label, ledger.balance, st.skip_counter)
                break

    def _tick_taker_momentum(self, cfg, st: EngineState, ledger: PaperLedger, books: Dict[str, OrderBook]):
        pos = st.current_trial
        if pos is not None and pos.status == "OPEN":
            book = books.get(pos.token_id)
            if book is None:
                return
            if book.best_bid is not None and book.best_bid >= config.TAKE_PROFIT_TRIGGER_PRICE:
                ledger.close_take_profit(pos)
                storage.record_position(pos)
                storage.save_engine_state(cfg.label, ledger.balance, 0)
                st.current_trial = None
            elif book.best_bid is not None and book.best_bid <= cfg.sl_price:
                ledger.close_stop_loss_at(pos, cfg.sl_price, self._fee_rate())
                storage.record_position(pos)
                storage.save_engine_state(cfg.label, ledger.balance, 0)
                st.current_trial = None
            return

        if st.entered_this_window:
            return

        for outcome in ("Up", "Down"):
            tok = self.window.tokens.get(outcome)
            if tok is None:
                continue
            book = books.get(tok.token_id)
            if book is None or book.best_ask is None:
                continue
            if book.best_ask >= cfg.price:
                new_pos = ledger.open_position(
                    self.window.window_start, outcome, tok.token_id, book.best_ask,
                    self._fee_rate(), is_shadow=False,
                )
                st.current_trial = new_pos
                st.entered_this_window = True
                self.log.info("[%s] momentum trigger hit on %s @%.4f -> bought as taker",
                             cfg.label, outcome, book.best_ask)
                storage.save_engine_state(cfg.label, ledger.balance, 0)
                break

    # --------------------------------------------------------- resolver task
    async def resolver_loop(self):
        while True:
            await asyncio.sleep(config.RESOLUTION_POLL_SECONDS)
            for cfg in config.ENGINES:
                st = self.states[cfg.label]
                if not st.awaiting_resolution:
                    continue
                still_waiting = []
                for pos in st.awaiting_resolution:
                    resolved = await self._try_resolve(cfg.label, pos)
                    if resolved:
                        st.awaiting_since.pop(pos.id, None)
                        st.warned_stale_ids.discard(pos.id)
                    else:
                        still_waiting.append(pos)
                        elapsed = time.time() - st.awaiting_since.get(pos.id, time.time())
                        if elapsed > config.RESOLUTION_POLL_TIMEOUT_SECONDS and pos.id not in st.warned_stale_ids:
                            st.warned_stale_ids.add(pos.id)
                            self.log.warning(
                                "[%s] position %s (%s, window %s) awaiting resolution for %.0fs",
                                cfg.label, pos.id, pos.outcome, pos.window_start, elapsed,
                            )
                st.awaiting_resolution = still_waiting

    async def _official_outcome(self, window_start: int) -> Optional[str]:
        win = await self.gamma.get_window(config.ASSET, window_start, config.WINDOW_SECONDS, config.WINDOW_LABEL)
        if win is None or not win.closed or not win.outcome_prices:
            return None
        names = list(win.tokens.keys())
        try:
            prices = [float(p) for p in win.outcome_prices]
        except (TypeError, ValueError):
            return None
        if len(prices) != len(names):
            return None
        idx_max = max(range(len(prices)), key=lambda i: prices[i])
        if prices[idx_max] < config.GAMMA_RESOLUTION_CONFIDENCE:
            return None
        return names[idx_max]

    async def _clob_fallback_outcome(self, token_id: str) -> Optional[bool]:
        try:
            price = await self.clob.get_last_trade_price(token_id)
        except Exception:
            return None
        if price is None:
            return None
        if price >= config.CLOB_FALLBACK_PRICE_THRESHOLD:
            return True
        if price <= (1.0 - config.CLOB_FALLBACK_PRICE_THRESHOLD):
            return False
        return None

    async def _try_resolve(self, engine_label: str, pos: Position) -> bool:
        window_end = pos.window_start + config.WINDOW_SECONDS
        if time.time() < window_end:
            return False
        elapsed_since_close = time.time() - window_end

        won = None
        source = None
        try:
            winning_outcome = await self._official_outcome(pos.window_start)
        except Exception as e:
            self.log.warning("[%s] resolve: gamma fetch failed for window %s: %s",
                             engine_label, pos.window_start, e)
            winning_outcome = None

        if winning_outcome is not None:
            won = (pos.outcome == winning_outcome)
            source = "gamma_official"
        elif elapsed_since_close > config.GAMMA_RESOLUTION_TIMEOUT_SECONDS:
            fallback = await self._clob_fallback_outcome(pos.token_id)
            if fallback is not None:
                won = fallback
                source = "clob_fallback (last_trade_price)"
                self.log.warning(
                    "[%s] %s had no Gamma confirmation for %.0fs -- resolved via CLOB fallback instead",
                    engine_label, pos.outcome, elapsed_since_close,
                )

        if won is None:
            return False

        self.log.info("[%s] %s resolved via %s -> won=%s", engine_label, pos.outcome, source, won)
        ledger = self.ledgers[engine_label]
        cfg = self.cfg_by_label[engine_label]
        st = self.states[engine_label]
        ledger.resolve(pos, won)
        storage.record_position(pos)
        if cfg.kind == "limit_cancel_skip":
            self._apply_skip_result(cfg, st, won=pos.won)
        storage.save_engine_state(engine_label, ledger.balance, st.skip_counter)
        return True

    # ----------------------------------------------------------------- loop
    async def run_forever(self):
        asyncio.create_task(self.resolver_loop())
        while True:
            try:
                await self.tick()
            except Exception:
                self.log.exception("tick failed")
                self.status_note = "error (see logs)"
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def close(self):
        await self.gamma.close()
        await self.clob.close()

    # ----------------------------------------------------------- status view
    def _engine_snapshot(self, cfg) -> dict:
        st = self.states[cfg.label]
        ledger = self.ledgers[cfg.label]
        pos = st.current_trial
        book = self.last_books.get(pos.token_id) if pos else None
        live_bid = book.best_bid if book else None
        unrealized = None
        if pos is not None and live_bid is not None:
            unrealized = pos.shares * live_bid - pos.entry_cost - pos.entry_fee

        out = {
            "label": cfg.label,
            "kind": cfg.kind,
            "price": cfg.price,
            "sl_price": cfg.sl_price,
            "skip_length": cfg.skip_length,
            "balance": round(ledger.balance, 2),
            "starting_capital": ledger.starting_capital,
            "skip_counter": st.skip_counter if cfg.kind == "limit_cancel_skip" else None,
            "mode": ("SHADOW" if st.this_window_is_shadow else "REAL") if cfg.kind == "limit_cancel_skip" else "REAL",
            "open_position": None,
            "awaiting_count": len(st.awaiting_resolution),
        }
        if pos is not None:
            out["open_position"] = {
                "outcome": pos.outcome, "is_shadow": pos.is_shadow, "entry_price": pos.entry_price,
                "shares": pos.shares, "live_bid": live_bid,
                "unrealized_pnl": round(unrealized, 4) if unrealized is not None else None,
            }
        return out

    def status(self) -> dict:
        now = time.time()
        window_info = None
        sides_info = {}
        if self.window:
            window_info = {
                "slug": self.window.slug,
                "window_start": self.window.window_start,
                "window_end": self.window.window_end,
                "seconds_left": max(0, round(self.window.window_end - now)),
            }
            for name, tok in self.window.tokens.items():
                b = self.last_books.get(tok.token_id)
                sides_info[name] = {"best_bid": b.best_bid if b else None, "best_ask": b.best_ask if b else None}

        engines_out = {cfg.label: self._engine_snapshot(cfg) for cfg in config.ENGINES}
        total_balance = sum(l.balance for l in self.ledgers.values())
        total_starting = sum(l.starting_capital for l in self.ledgers.values())

        recent_by_engine = {}
        for cfg in config.ENGINES:
            ledger = self.ledgers[cfg.label]
            recent = sorted(ledger.history, key=lambda p: p.closed_at or 0, reverse=True)[:10]
            recent_by_engine[cfg.label] = [{
                "window_start": p.window_start, "outcome": p.outcome, "status": p.status,
                "won": p.won, "raw_pnl": round(p.raw_pnl, 4) if p.raw_pnl is not None else None,
            } for p in recent]

        return {
            "status": self.status_note,
            "tick": self.tick_count,
            "server_time": time.time(),
            "total_balance": round(total_balance, 2),
            "total_starting_capital": round(total_starting, 2),
            "window": window_info,
            "sides": sides_info,
            "engines": engines_out,
            "recent_by_engine": recent_by_engine,
            "config": {
                "shares_per_trade": config.SHARES_PER_TRADE,
                "take_profit_trigger": config.TAKE_PROFIT_TRIGGER_PRICE,
                "poll_interval_seconds": config.POLL_INTERVAL_SECONDS,
            },
        }
