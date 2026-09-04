"""
Combines the two legs of a cross-asset pair (e.g. BTC-Up + ETH-Down) into
a single tradeable "combined price", both for entry (ask side) and exit
(bid side) checks.
"""
from dataclasses import dataclass
from typing import Dict

from . import config
from .clobbook import OrderBook


@dataclass
class LegRef:
    asset: str      # "btc" / "eth"
    outcome: str    # "Up" / "Down"
    token_id: str


@dataclass
class PairBooks:
    pair_id: str
    legs: Dict[str, OrderBook]  # keyed by "{asset}:{outcome}"

    def combined_ask(self):
        asks = [b.best_ask for b in self.legs.values()]
        if any(a is None for a in asks):
            return None
        return sum(asks)

    def combined_bid(self):
        bids = [b.best_bid for b in self.legs.values()]
        if any(b is None for b in bids):
            return None
        return sum(bids)


def pair_leg_refs(window_by_asset) -> Dict[str, list]:
    """
    window_by_asset: {"btc": MarketWindow, "eth": MarketWindow}
    returns {pair_id: [LegRef, LegRef]}
    """
    out = {}
    for pair_id, legs in config.PAIR_DEFS.items():
        refs = []
        for asset, outcome in legs:
            win = window_by_asset.get(asset)
            if win is None:
                refs = None
                break
            tok = win.tokens.get(outcome)
            if tok is None:
                refs = None
                break
            refs.append(LegRef(asset=asset, outcome=outcome, token_id=tok.token_id))
        if refs:
            out[pair_id] = refs
    return out
