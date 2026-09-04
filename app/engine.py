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

from . import config, fees

log = logging.getLogger("engine")

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
    closed_at: Optional[float] = None
    exit_legs: Optional[Dict[str, LegFill]] = None
    exit_proceeds: Optional[float] = None
    exit_fees: Optional[float] = None
    realized_pnl: Optional[float] = None
    resolution_payout: Optional[float] = None
    resolution_detail: Optional[dict] = None
    post_fill_check: Optional[dict] = None  # book snapshot a couple ticks later


class PaperEngine:
    def __init__(self, starting_capital: float = None):
        self.balance = starting_capital if starting_capital is not None else config.STARTING_CAPITAL_USD
        self.starting_capital = self.balance
        self.open_positions: Dict[str, Position] = {}   # pair_id -> Position (1 at a time per pair)
        self.history: List[Position] = []

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
        log.info(
            "OPEN %s window=%s cost=%.4f fees=%.4f balance=%.2f",
            pair_id, window_start, total_shares_cost, total_fees, self.balance,
        )
        return pos

    # ---- take-profit exit (only for pairs in config.TP_PAIR_IDS) -------------
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
        log.info(
            "CLOSE_TP %s pnl=%.4f balance=%.2f",
            pos.pair_id, pos.realized_pnl, self.balance,
        )
        return pos

    # ---- resolution (held to window close) -----------------------------------
    def resolve_position(self, pos: Position, winning_outcome_by_asset: Dict[str, str]) -> Position:
        """
        winning_outcome_by_asset: {"btc": "Up"/"Down", "eth": "Up"/"Down"}
        Each leg pays $1/share if its outcome matches the winner for that
        asset, else $0/share. No fee on redemption (it's a claim, not a trade).
        """
        payout = 0.0
        detail = {}
        for key, lf in pos.entry_legs.items():
            won = winning_outcome_by_asset.get(lf.asset) == lf.outcome
            leg_payout = lf.shares * (1.0 if won else 0.0)
            payout += leg_payout
            detail[key] = {"won": won, "shares": lf.shares, "payout": leg_payout}

        pos.status = "RESOLVED"
        pos.closed_at = time.time()
        pos.resolution_payout = payout
        pos.resolution_detail = detail
        pos.realized_pnl = payout - (pos.entry_cost + pos.entry_fees)

        self.balance += payout
        self.open_positions.pop(pos.pair_id, None)
        self.history.append(pos)
        log.info(
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
