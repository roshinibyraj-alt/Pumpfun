"""
Simulates a taker (marketable) buy order against a *real* snapshot of
Polymarket's public order book, so paper P&L reflects real depth/slippage
instead of assuming an instant fill at the top-of-book price.

The strategy is buy-and-hold-to-resolution only (no intra-window
take-profit, no re-entry), so this module only needs a buy-side walk.
Buys walk the ask side upward, capped at BUY_SLIPPAGE_CEILING; a leg can
partially fill if the book doesn't have enough depth inside the cap --
this is logged so it's never silently assumed away.
"""
from dataclasses import dataclass, field
from typing import List, Tuple

from . import config


@dataclass
class FillResult:
    requested_shares: float
    filled_shares: float
    avg_price: float
    lots: List[Tuple[float, float]] = field(default_factory=list)  # (price, shares)
    fully_filled: bool = False

    @property
    def notional(self) -> float:
        return sum(p * s for p, s in self.lots)


def simulate_buy(asks: List[Tuple[float, float]], shares_wanted: float) -> FillResult:
    """Walk asks (ascending price) up to BUY_SLIPPAGE_CEILING."""
    remaining = shares_wanted
    lots = []
    for price, size in asks:
        if price > config.BUY_SLIPPAGE_CEILING:
            break
        take = min(remaining, size)
        if take <= 0:
            continue
        lots.append((price, take))
        remaining -= take
        if remaining <= 1e-9:
            break
    filled = shares_wanted - remaining
    avg = (sum(p * s for p, s in lots) / filled) if filled > 0 else 0.0
    return FillResult(
        requested_shares=shares_wanted,
        filled_shares=filled,
        avg_price=avg,
        lots=lots,
        fully_filled=remaining <= 1e-9,
    )
