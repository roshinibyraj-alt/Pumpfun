"""Regression tests for sizing, binary settlement, and entry execution."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import config
from app.engine import Engine
from app.models import Side, WindowMarket
from app.paper_broker import PaperBroker


def window(n: int) -> WindowMarket:
    return WindowMarket(f"btc-updown-5m-{n}", None, "up", "down", n * 300, n * 300 + 300)


def tick(engine, side, now, ask, levels=None):
    kwargs = {"up_ask_levels": levels, "down_ask_levels": levels}
    engine.on_tick(
        ask if side == Side.UP else 0.2,
        ask if side == Side.UP else 0.2,
        0.2 if side == Side.UP else ask,
        ask if side == Side.DOWN else 0.2,
        now=now,
        **kwargs,
    )


def test_win_progression_and_direction_reset():
    engine = Engine(PaperBroker())
    size_history = []
    for n in range(1, 6):
        w = window(n)
        engine.reset_for_window(w, Side.UP)
        assert engine.s.share_size == 500 - (n - 1) * 100
        size_history.append(engine.s.share_size)
        tick(engine, Side.UP, w.open_ts + 1, 0.39, [(0.39, 1000)])
        assert engine.s.position is not None
        engine.finalize_window(Side.UP)
    assert size_history == [500, 400, 300, 200, 100]
    assert engine.next_shares == 0

    same = window(6)
    engine.reset_for_window(same, Side.UP)
    assert engine.s.signal_status == "zero_share_skip"

    flipped = window(7)
    engine.reset_for_window(flipped, Side.DOWN)
    assert engine.s.signal_status == "armed"
    assert engine.s.share_size == 500


def test_loss_resets_and_binary_payout():
    engine = Engine(PaperBroker())
    w = window(20)
    engine.reset_for_window(w, Side.DOWN)
    tick(engine, Side.DOWN, w.open_ts + 1, 0.40, [(0.40, 1000)])
    before = engine.capital.balance
    engine.finalize_window(Side.UP)
    assert engine.next_shares == 500
    assert engine.total_losses == 1
    assert engine.s.last_window_pnl < 0
    assert engine.capital.balance == before


def test_limit_timeout_then_taker():
    engine = Engine(PaperBroker())
    w = window(30)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.45, [(0.45, 1000)])
    assert engine.s.position is None
    tick(engine, Side.UP, w.open_ts + 31, 0.55, [(0.55, 1000)])
    assert engine.s.position is not None
    assert engine.s.position.entry_type == "taker"
    assert engine.total_limit_cancels == 1


def test_live_mark_to_market_equity():
    engine = Engine(PaperBroker())
    w = window(40)
    engine.reset_for_window(w, Side.UP)
    engine.on_tick(
        0.35, 0.40, 0.20, 0.80,
        now=w.open_ts + 1,
        up_ask_levels=[(0.40, 1000)],
        down_ask_levels=[(0.80, 1000)],
    )
    snapshot = engine.snapshot()
    assert snapshot["cash_balance"] == 1800.0
    assert snapshot["position"]["mark_price"] == 0.35
    assert snapshot["position"]["market_value"] == 175.0
    assert snapshot["unrealized_pnl"] == -25.0
    assert snapshot["equity"] == 1975.0

    # A later CLOB bid moves portfolio equity without realizing the P&L.
    engine.on_tick(
        0.46, 0.50, 0.20, 0.80,
        now=w.open_ts + 2,
        up_ask_levels=[(0.50, 1000)],
        down_ask_levels=[(0.80, 1000)],
    )
    snapshot = engine.snapshot()
    assert snapshot["realized_pnl"] == 0.0
    assert snapshot["unrealized_pnl"] == 30.0
    assert snapshot["equity"] == 2030.0


if __name__ == "__main__":
    test_win_progression_and_direction_reset()
    test_loss_resets_and_binary_payout()
    test_limit_timeout_then_taker()
    test_live_mark_to_market_equity()
    print("ENGINE TESTS PASSED")