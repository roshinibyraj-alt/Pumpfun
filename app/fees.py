"""
Polymarket crypto-category markets charge a dynamic, TAKER-ONLY fee:

    fee_usd = shares * fee_rate * price * (1 - price)

Fee peaks at price=0.50 and shrinks toward the extremes. Makers pay $0.
This bot is taker-only by design (see config.py), so this fee applies to
every buy and every sell fill. We compute it per fill-lot (each price
level consumed while walking the book) for accuracy, since a single
order can sweep multiple price levels.
"""


def fee_for_lot(shares: float, price: float, fee_rate: float) -> float:
    return shares * fee_rate * price * (1.0 - price)


def fee_for_lots(lots, fee_rate: float) -> float:
    """lots: iterable of (price, shares_filled_at_that_price)"""
    return sum(fee_for_lot(shares, price, fee_rate) for price, shares in lots)
