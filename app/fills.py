"""
Fill simulation shared by all 9 engines.

Entries and stop-losses are booked AT THEIR OWN TARGET PRICE (the resting
limit price for E1-E5, the momentum trigger's live ask for E6-E9, the SL
level for a stop-out) rather than walking live order-book depth -- the
same simplifying convention used throughout this series of bots. Take-
profit is a special case per spec: it pays a clean $1.00/share with NO
fee, treated identically to a winning resolution rather than an actual
market sale at 0.99 -- see engine.py.
"""
from . import fees as fees_mod


def fill_cost(price: float, shares: float, fee_rate: float) -> tuple:
    """Returns (notional_cost, fee) for filling `shares` at `price`."""
    notional = price * shares
    fee = fees_mod.fee_for_lot(shares, price, fee_rate)
    return notional, fee
