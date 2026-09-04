"""
Main trading loop.

Every POLL_INTERVAL_SECONDS:
  1. Make sure we have the current window's market data for BTC & ETH
     (rolling to the next window at each WINDOW_SECONDS boundary; any
     position still open when its window ends moves to "awaiting
     resolution"; the first-fired/TP-lock state resets for the new
     window; and the decorrelation sizing boost, if armed, is consumed
     here -- see step 5).
  2. Fetch live order books for all 4 outcome tokens.
  3. Each pair (BTC-Up+ETH-Down, BTC-Down+ETH-Up) can fire at most once per
     window, when its combined ask drops below ENTRY_COMBINED_PRICE (buy
     the window's current shares/leg of each leg -- BASE_SHARES_PER_LEG
     normally, or BOOSTED_SHARES_PER_LEG for one window after a
     decorrelation -- taker, capped at BUY_SLIPPAGE_CEILING). TP
     eligibility is decided dynamically by trigger order, not by which
     pair it is:
       - whichever pair fires FIRST in the window gets an intra-window
         take-profit: if its combined bid rises to EXIT_COMBINED_PRICE or
         above, both legs are sold immediately and that pair is then
         LOCKED for the rest of the window (no re-entry).
       - whichever pair fires SECOND (or is the only one that fires) gets
         no take-profit at all -- it's simply held to resolution.
  4. Positions still open when their window ends (no TP, or TP never
     triggered) are resolved once Polymarket settles the market (see
     resolver task).
  5. Decorrelation sizing: if a resolved position shows BOTH legs lost
     (payout == $0 -- the actual BTC/ETH outcome was the exact opposite
     combo of what was bought), the boost is armed. It's consumed at the
     next window roll (whichever window hasn't fired entries yet at that
     point), bumping that one window's entries to BOOSTED_SHARES_PER_LEG.
     The window after that always reverts to BASE_SHARES_PER_LEG,
     regardless of how the boosted window turned out.
"""
import asyncio
import logging
import time
from typing import Dict, Optional

from . import config, fills, storage
from .clobbook import ClobClient, OrderBook
from .engine import LegFill, PaperEngine, Position
from .gamma import GammaClient, MarketWindow, current_window_start
from .pairs import PairBooks, pair_leg_refs

log = logging.getLogger("strategy")


class Bot:
    def __init__(self):
        self.gamma = GammaClient()
        self.clob = ClobClient()
        self.engine = PaperEngine(starting_capital=storage.load_balance(config.STARTING_CAPITAL_USD))
        self.windows: Dict[str, MarketWindow] = {}          # asset -> current MarketWindow
        self.awaiting_resolution: list[Position] = []
        self.pending_fill_checks: list[dict] = []           # [{pos, legs: {key: token_id}, ticks_left}]
        self.last_books: Dict[str, OrderBook] = {}          # token_id -> OrderBook (latest snapshot)
        self.tick_count = 0
        self.status_note = "starting"

        # Dynamic per-window TP assignment: whichever pair fires FIRST in a
        # window gets the intra-window take-profit; once that TP hits, the
        # pair is locked (no re-entry) for the rest of the window. Whichever
        # pair fires SECOND (or the only one that fires) gets no TP at all
        # and is simply held to resolution. Both reset every time the
        # window rolls.
        self.current_window_start: Optional[int] = None
        self.window_first_fired: Optional[str] = None
        self.fired_pairs_this_window: set = set()

        # Decorrelation-triggered sizing boost. current_shares_per_leg is
        # what new entries use for the ACTIVE window; it's decided once,
        # at the moment a window rolls, based on whether a decorrelation
        # was flagged (pending_boost) since the last roll. It always
        # reverts to base the roll after a boosted window, win or lose.
        self.current_shares_per_leg: int = config.BASE_SHARES_PER_LEG
        self.pending_boost: bool = False

        # Diagnostics: when a position entered awaiting_resolution, and
        # which ones we've already warned about taking too long.
        self.awaiting_since: Dict[int, float] = {}
        self._warned_stale_ids: set = set()

    # ---------------------------------------------------------------- windows
    async def _ensure_windows(self):
        ws = current_window_start()
        if self.current_window_start is not None and ws != self.current_window_start:
            self.window_first_fired = None
            self.fired_pairs_this_window = set()
            if self.pending_boost:
                self.current_shares_per_leg = config.BOOSTED_SHARES_PER_LEG
                self.pending_boost = False
                log.info("decorrelation boost ARMED for window %s -> %d shares/leg",
                         ws, self.current_shares_per_leg)
            else:
                self.current_shares_per_leg = config.BASE_SHARES_PER_LEG
        self.current_window_start = ws

        for asset in config.ASSETS:
            win = self.windows.get(asset)
            if win is None or win.window_start != ws:
                new_win = await self.gamma.get_window(asset, ws)
                if new_win is None:
                    log.warning("could not load %s window for %s (will retry)", asset, ws)
                    continue
                # any open position tied to the OLD window that never hit
                # take-profit moves to awaiting-resolution, freeing the pair
                # up immediately for the new window.
                if win is not None:
                    self._roll_window(asset, win)
                self.windows[asset] = new_win

    def _roll_window(self, asset: str, old_win: MarketWindow):
        for pair_id, pos in list(self.engine.open_positions.items()):
            if pos.window_start == old_win.window_start and any(
                lf.asset == asset for lf in pos.entry_legs.values()
            ):
                self.engine.open_positions.pop(pair_id, None)
                self.awaiting_resolution.append(pos)
                self.awaiting_since[pos.id] = time.time()
                log.info("window %s rolled; moving %s position to awaiting_resolution", old_win.slug, pair_id)

    # ------------------------------------------------------------------ books
    async def _fetch_all_books(self) -> Dict[str, OrderBook]:
        token_ids = set()
        for win in self.windows.values():
            for tok in win.tokens.values():
                token_ids.add(tok.token_id)
        # also keep fetching books for tokens still awaiting resolution
        for pos in self.awaiting_resolution:
            for lf in pos.entry_legs.values():
                token_ids.add(lf.token_id)

        results = await asyncio.gather(
            *[self.clob.get_book(t) for t in token_ids], return_exceptions=True
        )
        books = {}
        for tok, res in zip(token_ids, results):
            if isinstance(res, Exception):
                log.warning("book fetch failed for %s: %s", tok, res)
                continue
            books[tok] = res
        self.last_books.update(books)
        return books

    def _pair_books(self, books: Dict[str, OrderBook]) -> Dict[str, PairBooks]:
        refs = pair_leg_refs(self.windows)
        out = {}
        for pair_id, legs in refs.items():
            leg_books = {}
            ok = True
            for leg in legs:
                b = books.get(leg.token_id)
                if b is None:
                    ok = False
                    break
                leg_books[f"{leg.asset}:{leg.outcome}"] = b
            if ok:
                out[pair_id] = PairBooks(pair_id=pair_id, legs=leg_books)
        return out

    # ------------------------------------------------------------------ fills
    def _fee_rate_for_asset(self, asset: str) -> float:
        win = self.windows.get(asset)
        return win.taker_fee_rate if win else config.FALLBACK_TAKER_FEE_RATE

    def _buy_pair(self, pair_id: str, pb: PairBooks):
        refs = pair_leg_refs(self.windows)[pair_id]
        shares_wanted = self.current_shares_per_leg
        leg_fills = {}
        for leg in refs:
            book = pb.legs[f"{leg.asset}:{leg.outcome}"]
            fr = fills.simulate_buy(book.asks, shares_wanted)
            if fr.filled_shares <= 0:
                log.warning("BUY %s leg %s:%s got 0 fill (book too thin under slippage cap)",
                            pair_id, leg.asset, leg.outcome)
                return None
            if not fr.fully_filled:
                log.warning("BUY %s leg %s:%s partially filled %.1f/%.1f",
                            pair_id, leg.asset, leg.outcome, fr.filled_shares, shares_wanted)
            from . import fees as fees_mod
            fee = fees_mod.fee_for_lots(fr.lots, self._fee_rate_for_asset(leg.asset))
            leg_fills[f"{leg.asset}:{leg.outcome}"] = LegFill(
                asset=leg.asset, outcome=leg.outcome, token_id=leg.token_id,
                shares=fr.filled_shares, avg_price=fr.avg_price, fee=fee,
                fully_filled=fr.fully_filled,
            )
        win_start = self.windows[refs[0].asset].window_start
        pos = self.engine.open_position(pair_id, win_start, leg_fills)
        pos.entry_shares_per_leg = shares_wanted
        self._queue_post_fill_check(pos)
        return pos

    def _sell_pair(self, pos: Position, pb: PairBooks):
        leg_fills = {}
        for key, entry_lf in pos.entry_legs.items():
            book = pb.legs[key]
            fr = fills.simulate_sell(book.bids, entry_lf.shares)
            if fr.filled_shares <= 0:
                log.warning("SELL %s leg %s got 0 fill; holding to resolution instead", pos.pair_id, key)
                return None
            if not fr.fully_filled:
                log.warning("SELL %s leg %s partially filled %.1f/%.1f",
                            pos.pair_id, key, fr.filled_shares, entry_lf.shares)
            from . import fees as fees_mod
            fee = fees_mod.fee_for_lots(fr.lots, self._fee_rate_for_asset(entry_lf.asset))
            leg_fills[key] = LegFill(
                asset=entry_lf.asset, outcome=entry_lf.outcome, token_id=entry_lf.token_id,
                shares=fr.filled_shares, avg_price=fr.avg_price, fee=fee,
                fully_filled=fr.fully_filled,
            )
        closed = self.engine.close_position_tp(pos, leg_fills)
        storage.record_trade(closed)
        storage.save_balance(self.engine.balance)
        return closed

    def _queue_post_fill_check(self, pos: Position):
        self.pending_fill_checks.append({
            "pos": pos,
            "legs": {k: lf.token_id for k, lf in pos.entry_legs.items()},
            "ticks_left": config.POST_FILL_CHECK_TICKS,
        })

    async def _process_post_fill_checks(self, books: Dict[str, OrderBook]):
        still_pending = []
        for item in self.pending_fill_checks:
            item["ticks_left"] -= 1
            if item["ticks_left"] > 0:
                still_pending.append(item)
                continue
            snapshot = {}
            for key, tok in item["legs"].items():
                b = books.get(tok)
                if b:
                    snapshot[key] = {"best_bid": b.best_bid, "best_ask": b.best_ask}
            item["pos"].post_fill_check = snapshot
            log.info("post-fill check for position %s: %s", item["pos"].id, snapshot)
        self.pending_fill_checks = still_pending

    # -------------------------------------------------------------- one tick
    async def tick(self):
        self.tick_count += 1
        await self._ensure_windows()
        if len(self.windows) < len(config.ASSETS):
            self.status_note = "waiting for market discovery"
            return

        books = await self._fetch_all_books()
        await self._process_post_fill_checks(books)
        pairs = self._pair_books(books)

        for pair_id, pb in pairs.items():
            open_pos = self.engine.open_positions.get(pair_id)

            if open_pos is None:
                # A pair that already fired (and, if it had TP, already hit
                # it and got locked) does not get to fire again this window.
                if pair_id in self.fired_pairs_this_window:
                    continue
                ask = pb.combined_ask()
                if ask is not None and ask < config.ENTRY_COMBINED_PRICE:
                    pos = self._buy_pair(pair_id, pb)
                    if pos is not None:
                        self.fired_pairs_this_window.add(pair_id)
                        if self.window_first_fired is None:
                            # first pair to trigger this window -> gets TP
                            self.window_first_fired = pair_id
                            pos.has_tp = True
                            log.info("%s is the first pair to fire in window %s -> TP armed at %.2f",
                                     pair_id, pos.window_start, config.EXIT_COMBINED_PRICE)
                        else:
                            pos.has_tp = False
                            log.info("%s fired second in window %s -> no TP, holding to resolution",
                                     pair_id, pos.window_start)
            elif open_pos.has_tp:
                bid = pb.combined_bid()
                if bid is not None and bid >= config.EXIT_COMBINED_PRICE:
                    # Selling frees the pair_id from open_positions, but it
                    # stays in fired_pairs_this_window -> locked, no re-entry.
                    self._sell_pair(open_pos, pb)
            # else: no TP for this pair's current position -- just hold.

        self.status_note = "running"

    # --------------------------------------------------------- resolver task
    async def resolver_loop(self):
        while True:
            await asyncio.sleep(config.RESOLUTION_POLL_SECONDS)
            if not self.awaiting_resolution:
                continue
            still_waiting = []
            for pos in self.awaiting_resolution:
                resolved = await self._try_resolve(pos)
                if resolved:
                    self.awaiting_since.pop(pos.id, None)
                    self._warned_stale_ids.discard(pos.id)
                else:
                    still_waiting.append(pos)
                    elapsed = time.time() - self.awaiting_since.get(pos.id, time.time())
                    if elapsed > config.RESOLUTION_POLL_TIMEOUT_SECONDS and pos.id not in self._warned_stale_ids:
                        self._warned_stale_ids.add(pos.id)
                        log.warning(
                            "position %s (%s, window %s) has been awaiting resolution for %.0fs "
                            "with no confident CLOB price on one or both legs -- still polling",
                            pos.id, pos.pair_id, pos.window_start, elapsed,
                        )
            self.awaiting_resolution = still_waiting

    async def _try_resolve(self, pos: Position) -> bool:
        """
        Resolve using ONLY the CLOB order book (no Gamma outcomePrices /
        closed check, no fallback path). For each leg the position
        actually holds, fetch a fresh book for that leg's own token: if
        its price is confidently high (>= RESOLUTION_PRICE_THRESHOLD) the
        leg is treated as the winner ($1/share); if confidently low
        (<= 1 - RESOLUTION_PRICE_THRESHOLD) it's a loser ($0/share). If
        any leg's price is still ambiguous, we keep waiting and re-poll.
        """
        window_end = pos.window_start + config.WINDOW_SECONDS
        if time.time() < window_end:
            return False  # window hasn't even closed yet

        threshold = config.RESOLUTION_PRICE_THRESHOLD
        leg_won: Dict[str, bool] = {}
        for key, lf in pos.entry_legs.items():
            try:
                book = await self.clob.get_book(lf.token_id)
            except Exception as e:
                log.warning("resolve: book fetch failed for %s (%s): %s", key, lf.token_id, e)
                return False
            self.last_books[lf.token_id] = book

            price = book.last_trade_price if book.last_trade_price is not None else book.best_bid
            if price is None:
                return False  # no price data yet -- keep polling

            if price >= threshold:
                leg_won[key] = True
            elif price <= (1.0 - threshold):
                leg_won[key] = False
            else:
                log.debug("resolve: %s price %.3f still ambiguous (need >=%.2f or <=%.2f)",
                          key, price, threshold, 1.0 - threshold)
                return False  # not confidently settled yet

        resolved = self.engine.resolve_position_by_leg(pos, leg_won)
        storage.record_trade(resolved)
        storage.save_balance(self.engine.balance)

        # Decorrelation check: both legs lost (payout == 0) means the
        # actual outcome was the exact opposite combo of the pair bought.
        # Arm the sizing boost for the next window whose entries haven't
        # fired yet (consumed in _ensure_windows on the next roll).
        if resolved.resolution_payout is not None and resolved.resolution_payout <= 1e-9:
            self.pending_boost = True
            log.info(
                "DECORRELATION on %s (window %s): both legs lost -> "
                "boost armed, next window's entries will use %d shares/leg",
                resolved.pair_id, resolved.window_start, config.BOOSTED_SHARES_PER_LEG,
            )

        return True

    # ----------------------------------------------------------------- loop
    async def run_forever(self):
        asyncio.create_task(self.resolver_loop())
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("tick failed")
                self.status_note = "error (see logs)"
            await asyncio.sleep(config.POLL_INTERVAL_SECONDS)

    async def close(self):
        await self.gamma.close()
        await self.clob.close()

    # ----------------------------------------------------------- status view
    def _market_snapshot(self) -> dict:
        """Live Up/Down prices for BTC and ETH in the current window, for
        the dashboard's primary price panel."""
        now = time.time()
        out = {}
        for asset, win in self.windows.items():
            outcomes = {}
            for name, tok in win.tokens.items():
                b = self.last_books.get(tok.token_id)
                best_bid = b.best_bid if b else None
                best_ask = b.best_ask if b else None
                mid = None
                if best_bid is not None and best_ask is not None:
                    mid = round((best_bid + best_ask) / 2, 4)
                outcomes[name] = {
                    "best_bid": best_bid,
                    "best_ask": best_ask,
                    "mid": mid,
                    "last_trade_price": b.last_trade_price if b else None,
                }
            out[asset] = {
                "slug": win.slug,
                "window_start": win.window_start,
                "window_end": win.window_end,
                "seconds_left": max(0, round(win.window_end - now)),
                "closed": win.closed,
                "outcomes": outcomes,
            }
        return out

    def _pair_snapshot(self) -> dict:
        """Live combined ask/bid for each cross-asset pair vs. its
        applicable thresholds (entry always; exit only if this pair won
        the "fired first" race for the current window)."""
        refs = pair_leg_refs(self.windows)
        out = {}
        for pair_id, legs in refs.items():
            leg_prices = {}
            asks, bids = [], []
            for leg in legs:
                b = self.last_books.get(leg.token_id)
                bb = b.best_bid if b else None
                ba = b.best_ask if b else None
                leg_prices[f"{leg.asset}:{leg.outcome}"] = {"best_bid": bb, "best_ask": ba}
                if ba is not None:
                    asks.append(ba)
                if bb is not None:
                    bids.append(bb)
            combined_ask = round(sum(asks), 4) if len(asks) == len(legs) else None
            combined_bid = round(sum(bids), 4) if len(bids) == len(legs) else None
            open_pos = self.engine.open_positions.get(pair_id)
            has_position = open_pos is not None
            already_fired = pair_id in self.fired_pairs_this_window
            has_tp = bool(open_pos.has_tp) if open_pos is not None else (
                self.window_first_fired == pair_id if self.window_first_fired else None
            )

            if has_position and open_pos.has_tp:
                state = "HOLDING_TP"
            elif has_position:
                state = "HOLDING_NO_TP"
            elif already_fired:
                state = "LOCKED"          # fired earlier, TP hit (or n/a), no re-entry
            else:
                state = "ARMED"

            out[pair_id] = {
                "legs": leg_prices,
                "combined_ask": combined_ask,
                "combined_bid": combined_bid,
                "has_tp": has_tp,
                "distance_to_entry": (
                    round(combined_ask - config.ENTRY_COMBINED_PRICE, 4)
                    if combined_ask is not None else None
                ),
                "distance_to_exit": (
                    round(config.EXIT_COMBINED_PRICE - combined_bid, 4)
                    if combined_bid is not None and has_position and open_pos.has_tp else None
                ),
                "has_open_position": has_position,
                "state": state,
            }
        return out

    def status(self) -> dict:
        current_bids = {}
        for pair_id in config.PAIR_DEFS:
            pos = self.engine.open_positions.get(pair_id)
            if not pos:
                continue
            leg_bids = {}
            for key, lf in pos.entry_legs.items():
                b = self.last_books.get(lf.token_id)
                if b and b.best_bid is not None:
                    leg_bids[key] = b.best_bid
            current_bids[pair_id] = leg_bids

        open_positions = []
        for pair_id, pos in self.engine.open_positions.items():
            u = self.engine.unrealized_pnl(pos, current_bids.get(pair_id, {}))
            open_positions.append({
                "pair_id": pair_id,
                "window_start": pos.window_start,
                "entry_cost": round(pos.entry_cost, 4),
                "entry_fees": round(pos.entry_fees, 4),
                "has_tp": pos.has_tp,
                "shares_per_leg": pos.entry_shares_per_leg,
                "unrealized_pnl": round(u, 4) if u is not None else None,
                "legs": {k: {"shares": v.shares, "avg_price": v.avg_price} for k, v in pos.entry_legs.items()},
            })

        awaiting = [{
            "pair_id": p.pair_id, "window_start": p.window_start,
            "entry_cost": round(p.entry_cost, 4), "entry_fees": round(p.entry_fees, 4),
            "shares_per_leg": p.entry_shares_per_leg,
        } for p in self.awaiting_resolution]

        recent = [{
            "id": p.id, "pair_id": p.pair_id, "status": p.status,
            "realized_pnl": round(p.realized_pnl, 4) if p.realized_pnl is not None else None,
            "closed_at": p.closed_at,
            "shares_per_leg": p.entry_shares_per_leg,
            "decorrelated": bool(p.status == "RESOLVED" and (p.resolution_payout or 0) <= 1e-9),
        } for p in self.engine.history[-25:][::-1]]

        equity = self.engine.equity({pid: current_bids.get(pid, {}) for pid in config.PAIR_DEFS})

        return {
            "status": self.status_note,
            "tick": self.tick_count,
            "server_time": time.time(),
            "balance_cash": round(self.engine.balance, 2),
            "equity": round(equity, 2),
            "starting_capital": self.engine.starting_capital,
            "windows": {a: {"slug": w.slug, "window_end": w.window_end} for a, w in self.windows.items()},
            "markets": self._market_snapshot(),
            "pairs": self._pair_snapshot(),
            "open_positions": open_positions,
            "awaiting_resolution": awaiting,
            "recent_trades": recent,
            "sizing": {
                "base_shares_per_leg": config.BASE_SHARES_PER_LEG,
                "boosted_shares_per_leg": config.BOOSTED_SHARES_PER_LEG,
                "current_window_shares_per_leg": self.current_shares_per_leg,
                "boost_armed_for_next_window": self.pending_boost,
            },
            "config": {
                "entry_combined_price": config.ENTRY_COMBINED_PRICE,
                "exit_combined_price": config.EXIT_COMBINED_PRICE,
                "buy_slippage_ceiling": config.BUY_SLIPPAGE_CEILING,
                "sell_slippage_floor": config.SELL_SLIPPAGE_FLOOR,
                "window_first_fired": self.window_first_fired,
            },
        }
