"""Paper fee and maker-rebate estimate helpers for Polymarket crypto markets."""
from decimal import Decimal, ROUND_HALF_UP

from . import config


FEE_PRECISION = Decimal("0.00001")


def _round_fee(value: Decimal) -> float:
    return float(value.quantize(FEE_PRECISION, rounding=ROUND_HALF_UP))


def crypto_fee_equivalent(shares: float, price: float) -> float:
    """Return C * feeRate * p * (1-p), rounded like Polymarket fees."""
    count = Decimal(str(shares))
    probability = Decimal(str(price))
    if count <= 0 or probability <= 0 or probability >= 1:
        return 0.0
    raw = count * Decimal(str(config.TAKER_FEE_RATE)) * probability * (1 - probability)
    return _round_fee(raw)


def crypto_taker_fee(shares: float, price: float) -> float:
    """Taker fees use the same fee-curve formula as fee-equivalent volume."""
    return crypto_fee_equivalent(shares, price)


def estimated_maker_rebate(shares: float, price: float) -> float:
    """Illustrative proxy; real rebates are daily, market-level pro-rata payouts."""
    equivalent = Decimal(str(crypto_fee_equivalent(shares, price)))
    estimate = equivalent * Decimal(str(config.MAKER_REBATE_ESTIMATE_FACTOR))
    return _round_fee(estimate)