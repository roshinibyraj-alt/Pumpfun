"""Regression tests for fixed-dollar sizing, timing, fees, and settlement."""
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.engine import Engine
from app.log_tracker import LogTracker
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker


def window(n: int) -> WindowMarket:
    return WindowMarket(f"btc-updown-5m-{n}", None, "up", "down", n * 300, n * 300 + 300)


def tick(engine, side, now, ask, levels=None, bid=None):
    engine.on_tick(
        bid if side == Side.UP else 0.2,
        ask if side == Side.UP else 0.2,
        0.2 if side == Side.UP else bid,
        ask if side == Side.DOWN else 0.2,
        now=now,
        up_ask_levels=levels if side == Side.UP else None,
        down_ask_levels=levels if side == Side.DOWN else None,
    )



def test_dollar_progression_and_direction_reset():
    engine = Engine(PaperBroker())
    sizes = [500, 400, 300, 200, 100]
    for n, size in enumerate(sizes, start=1):
        w = window(n)
        engine.reset_for_window(w, Side.UP)
        assert engine.s.order_usd == size
        tick(engine, Side.UP, w.open_ts + 1, 0.40, [(0.40, size / 0.40)], bid=0.35)
        assert engine.s.position.order_usd == size
        engine.finalize_window(Side.UP)
    assert engine.next_order_usd == 0

    same = window(6)
    engine.reset_for_window(same, Side.UP)
    assert engine.s.signal_status == "zero_order_skip"

    flipped = window(7)
    engine.reset_for_window(flipped, Side.DOWN)
    assert engine.s.signal_status == "armed"
    assert engine.s.order_usd == 500


def test_maker_uses_dollar_notional_and_rebate_formula():
    engine = Engine(PaperBroker())
    w = window(1)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.40, [(0.40, 1250)], bid=0.35)
    pos = engine.s.position
    assert pos is not None
    assert pos.order_usd == 500
    assert pos.shares == 1250
    assert pos.fee == 0.0
    assert pos.maker_rebate == 4.2
    assert engine.capital.balance == 4500
    engine.finalize_window(Side.UP)
    assert round(engine.total_pnl, 4) == 754.2
    assert engine.snapshot()["cash_balance"] == 5754.2


def test_live_fill_debits_and_settles_cash():
    engine = Engine(PaperBroker())
    w = window(8)
    engine.reset_for_window(w, Side.UP)
    assert engine.record_live_fill(Side.UP, 500, 1000, 0.50, w.open_ts + 1, "order-1")
    assert engine.capital.balance == 4500
    engine.finalize_window(Side.UP)
    assert engine.capital.balance == 5500
    assert engine.total_pnl == 500


def test_no_taker_fallback_before_30_seconds():
    engine = Engine(PaperBroker())
    w = window(2)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 10, 0.50, [(0.50, 1000)])
    assert engine.s.order.active is True
    assert engine.s.position is None


def test_timeout_cancels_limit_and_takes_under_060():
    engine = Engine(PaperBroker())
    w = window(3)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.45, [(0.45, 2000)])
    tick(engine, Side.UP, w.open_ts + 30, 0.55, [(0.55, 1000)], bid=0.50)
    pos = engine.s.position
    assert engine.s.order.active is False
    assert engine.total_limit_cancels == 1
    assert engine.total_taker_entries == 1
    assert pos is not None
    assert pos.entry_type == "taker"
    assert round(pos.order_usd, 6) == 500
    assert round(pos.shares, 6) == round(500 / 0.55, 6)
    assert round(pos.fee, 5) == 15.75
    assert round(pos.cost, 5) == 515.75


def test_above_threshold_waits_until_price_returns_under_060():
    engine = Engine(PaperBroker())
    w = window(4)
    engine.reset_for_window(w, Side.DOWN)
    tick(engine, Side.DOWN, w.open_ts + 1, 0.45, [(0.45, 2000)])
    tick(engine, Side.DOWN, w.open_ts + 30, 0.65, [(0.65, 2000)])
    assert engine.s.order.active is False
    assert engine.s.position is None
    assert engine.total_taker_entries == 0
    tick(engine, Side.DOWN, w.open_ts + 45, 0.59, [(0.59, 1000)], bid=0.55)
    assert engine.s.position is not None
    assert engine.s.position.entry_type == "taker"
    assert engine.total_taker_entries == 1


def test_taker_does_not_cross_price_cap_for_slippage():
    engine = Engine(PaperBroker())
    w = window(5)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 30, 0.59, [(0.59, 100), (0.61, 2000)])
    assert engine.s.position is None
    assert engine.total_taker_entries == 0


def test_mark_to_market_includes_actual_fee_and_rebate():
    engine = Engine(PaperBroker())
    w = window(6)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.40, [(0.40, 1250)], bid=0.30)
    snapshot = engine.snapshot()
    assert snapshot["cash_balance"] == 4500
    assert snapshot["position"]["notional_usd"] == 500
    assert snapshot["position"]["market_value"] == 375
    assert snapshot["unrealized_pnl"] == -120.8
    assert snapshot["equity"] == 4879.2


def test_taker_fee_and_maker_rebate_precision():
    broker = PaperBroker()
    assert broker.taker_fee_amount(100, 0.40) == 1.68
    assert broker.maker_rebate_amount(1250, 0.40) == 4.2


def test_structured_logs_include_dollar_size_and_fees():
    with tempfile.TemporaryDirectory() as directory:
        tracker = LogTracker(str(pathlib.Path(directory) / "events.jsonl"))
        broker = PaperBroker(tracker)
        broker.log_event("BOT", "window-1", "ENTRY_FILLED", side="UP", price=0.40, shares=1250, order_usd=500, fee=0.0, maker_rebate=4.2)
        record = tracker.query(event="ENTRY_FILLED")[0]
        assert record["order_usd"] == 500
        assert record["fee"] == 0.0
        assert record["maker_rebate"] == 4.2


if __name__ == "__main__":
    test_dollar_progression_and_direction_reset()
    test_maker_uses_dollar_notional_and_rebate_formula()
    test_live_fill_debits_and_settles_cash()
    test_no_taker_fallback_before_30_seconds()
    test_timeout_cancels_limit_and_takes_under_060()
    test_above_threshold_waits_until_price_returns_under_060()
    test_taker_does_not_cross_price_cap_for_slippage()
    test_mark_to_market_includes_actual_fee_and_rebate()
    test_taker_fee_and_maker_rebate_precision()
    test_structured_logs_include_dollar_size_and_fees()
    print("ENGINE TESTS PASSED")
