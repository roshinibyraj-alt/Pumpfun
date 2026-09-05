"""
Simulated (paper) trading engine. Holds the virtual bankroll, open
positions, and full trade/resolution history. No real orders are ever
signed or sent -- fills come from fills.py walking a real order book
snapshot, so the simulated P&L reflects real depth and Polymarket's real
dynamic taker fee.
"""
import itertools
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import fees

_default_log = logging.getLogger("engine")

_id_counter = itertools.count(1)


@dataclass
class LegFill:
    asset: str
    outcome: str
    token_id: str
    shares: float
    avg_price: float
    fee: float
    fully_filled: bool


@dataclass
class Position:
    id: int
    pair_id: str
    window_start: int
    opened_at: float
    entry_legs: Dict[str, LegFill]        # key "{asset}:{outcome}"
    entry_cost: float                      # notional paid, excl. fees
    entry_fees: float
    status: str = "OPEN"                   # OPEN | CLOSED_TP | RESOLVED
    has_tp: bool = False                    # set by strategy: True if this
                                             # was the first pair to fire in
                                             # its window (gets intra-window TP)
    entry_shares_per_leg: Optional[int] = None  # 10 (base) or 300 (post-decorrelation boost)
    closed_at: Optional[float] = None
    exit_legs: Optional[Dict[str, LegFill]] = None
    exit_proceeds: Optional[float] = None
    exit_fees: Optional[float] = None
    realized_pnl: Optional[float] = None
    resolution_payout: Optional[float] = None
    resolution_detail: Optional[dict] = None
    post_fill_check: Optional[dict] = None  # book snapshot a couple ticks later


class PaperEngine:
    def __init__(self, starting_capital: float = 2000.0, log: Optional[logging.Logger] = None):
        self.balance = starting_capital
        self.starting_capital = self.balance
        self.open_positions: Dict[str, Position] = {}   # pair_id -> Position (1 at a time per pair)
        self.history: List[Position] = []
        self.log = log or _default_log

    # ---- entry ------------------------------------------------------------
    def open_position(self, pair_id: str, window_start: int, leg_fills: Dict[str, LegFill]) -> Position:
        total_shares_cost = sum(lf.shares * lf.avg_price for lf in leg_fills.values())
        total_fees = sum(lf.fee for lf in leg_fills.values())
        pos = Position(
            id=next(_id_counter),
            pair_id=pair_id,
            window_start=window_start,
            opened_at=time.time(),
            entry_legs=leg_fills,
            entry_cost=total_shares_cost,
            entry_fees=total_fees,
        )
        self.balance -= (total_shares_cost + total_fees)
        self.open_positions[pair_id] = pos
        self.log.info(
            "OPEN %s window=%s cost=%.4f fees=%.4f balance=%.2f",
            pair_id, window_start, total_shares_cost, total_fees, self.balance,
        )
        return pos

    # ---- take-profit exit (only when this pair won the dynamic "fired
    # first" race for its window -- see strategy.py) --------------------------
    def close_position_tp(self, pos: Position, leg_fills: Dict[str, LegFill]) -> Position:
        proceeds = sum(lf.shares * lf.avg_price for lf in leg_fills.values())
        exit_fees = sum(lf.fee for lf in leg_fills.values())
        pos.exit_legs = leg_fills
        pos.exit_proceeds = proceeds
        pos.exit_fees = exit_fees
        pos.status = "CLOSED_TP"
        pos.closed_at = time.time()
        pos.realized_pnl = (proceeds - exit_fees) - (pos.entry_cost + pos.entry_fees)

        self.balance += (proceeds - exit_fees)
        self.open_positions.pop(pos.pair_id, None)
        self.history.append(pos)
        self.log.info(
            "CLOSE_TP %s pnl=%.4f balance=%.2f",
            pos.pair_id, pos.realized_pnl, self.balance,
        )
        return pos

    # ---- resolution (held to window close) -----------------------------------
    def resolve_position_by_leg(self, pos: Position, leg_won: Dict[str, bool]) -> Position:
        """
        Resolve using an explicit per-leg win/loss decision (as determined
        by the strategy from live CLOB prices -- see strategy._try_resolve).
        Each leg pays $1/share if leg_won[key] is True, else $0/share.

        Math invariant (worth spelling out, since it's easy to eyeball
        wrong): payout is the sum of ONLY the winning legs' own share
        counts, each at $1/share. For an N-shares-per-leg pair:
          - both legs win  -> payout = 2N  (max possible)
          - one leg wins   -> payout = N   (this is the only way to get
            a "partial" outcome -- e.g. N=10 -> payout is exactly $10,
            never more, since a leg can only ever pay $0 or $1/share)
          - both legs lose -> payout = 0   (decorrelation)
        realized_pnl = payout - (entry_cost + entry_fees), and entry_cost
        + entry_fees is always > 0, so realized_pnl is always strictly
        less than the payout -- e.g. a one-leg-wins result on a 10
        shares/leg pair can NEVER show more than just under $10 profit,
        let alone $11+. The assertions below make that structural
        guarantee loud (not silent) if it's ever violated by a future
        change.
        """
        payout = 0.0
        detail = {}
        total_shares_committed = sum(lf.shares for lf in pos.entry_legs.values())
        for key, lf in pos.entry_legs.items():
            won = bool(leg_won.get(key, False))
            leg_payout = lf.shares * (1.0 if won else 0.0)
            if leg_payout > lf.shares + 1e-9:
                self.log.critical(
                    "MATH BUG: leg %s payout %.4f exceeds its own share count %.4f -- "
                    "a leg can never pay more than $1/share. Refusing to apply.",
                    key, leg_payout, lf.shares,
                )
                raise AssertionError(f"leg payout {leg_payout} exceeds shares {lf.shares} for {key}")
            payout += leg_payout
            detail[key] = {"won": won, "shares": lf.shares, "payout": leg_payout}

        if payout > total_shares_committed + 1e-9:
            self.log.critical(
                "MATH BUG: total payout %.4f exceeds total shares committed %.4f for position %s -- "
                "refusing to apply.",
                payout, total_shares_committed, pos.id,
            )
            raise AssertionError(f"payout {payout} exceeds total shares {total_shares_committed}")

        pos.status = "RESOLVED"
        pos.closed_at = time.time()
        pos.resolution_payout = payout
        pos.resolution_detail = detail
        pos.realized_pnl = payout - (pos.entry_cost + pos.entry_fees)

        self.balance += payout
        self.open_positions.pop(pos.pair_id, None)
        self.history.append(pos)
        self.log.info(
            "RESOLVE %s payout=%.4f pnl=%.4f balance=%.2f",
            pos.pair_id, payout, pos.realized_pnl, self.balance,
        )
        return pos

    # ---- floating P&L ---------------------------------------------------------
    def unrealized_pnl(self, pos: Position, current_bid_by_leg: Dict[str, float]) -> Optional[float]:
        """Mark an open position to market using current best-bid per leg
        (what you'd actually receive if you sold right now)."""
        marks = []
        for key, lf in pos.entry_legs.items():
            bid = current_bid_by_leg.get(key)
            if bid is None:
                return None
            marks.append(lf.shares * bid)
        mark_value = sum(marks)
        return mark_value - (pos.entry_cost + pos.entry_fees)

    def equity(self, current_bid_by_leg_by_pair: Dict[str, Dict[str, float]]) -> float:
        """balance (cash) + mark-to-market value of open positions."""
        total = self.balance
        for pair_id, pos in self.open_positions.items():
            bids = current_bid_by_leg_by_pair.get(pair_id, {})
            u = self.unrealized_pnl(pos, bids)
            if u is not None:
                total += (pos.entry_cost + pos.entry_fees) + u
        return total
