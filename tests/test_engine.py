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
        tick(engine, Side.UP, w.open_ts + 1, 0.34, [(0.34, 1000)])
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
    tick(engine, Side.DOWN, w.open_ts + 1, 0.35, [(0.35, 1000)])
    before = engine.capital.balance
    engine.finalize_window(Side.UP)
    assert engine.next_shares == 500
    assert engine.total_losses == 1
    assert engine.s.last_window_pnl < 0
    assert engine.capital.balance == before


def test_limit_order_stays_active_for_full_window():
    engine = Engine(PaperBroker())
    w = window(30)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.45, [(0.45, 1000)])
    assert engine.s.position is None
    tick(engine, Side.UP, w.open_ts + 31, 0.55, [(0.55, 1000)])
    assert engine.s.position is None
    assert engine.s.order is not None
    assert engine.s.order.active is True
    assert engine.total_limit_cancels == 0
    assert engine.total_taker_entries == 0

    # A later ask at the limit can still fill during the same window.
    tick(engine, Side.UP, w.open_ts + 120, 0.35, [(0.35, 1000)])
    assert engine.s.position is not None
    assert engine.s.position.entry_type == "maker"
    assert engine.s.position.entry_price == 0.35
    assert engine.s.order.active is False


def test_no_fill_winner_reduces_progression_without_pnl():
    engine = Engine(PaperBroker())
    w = window(35)
    engine.reset_for_window(w, Side.UP)

    # The limit is too expensive at the start and remains unfilled later.
    tick(engine, Side.UP, w.open_ts + 1, 0.45, [(0.45, 1000)])
    tick(engine, Side.UP, w.open_ts + 31, 0.61, [(0.61, 1000)])
    assert engine.s.position is None
    before = engine.capital.balance

    engine.finalize_window(Side.UP)

    assert engine.next_shares == 400
    assert engine.total_wins == 1
    assert engine.total_no_trade == 1
    assert engine.total_pnl == 0.0
    assert engine.capital.balance == before
    assert engine.s.position is None
    assert engine.history[-1]["result"] == "WIN_NO_TRADE"


def test_no_fill_loss_resets_progression_without_pnl():
    engine = Engine(PaperBroker())
    w = window(36)
    engine.reset_for_window(w, Side.DOWN)
    tick(engine, Side.DOWN, w.open_ts + 1, 0.45, [(0.45, 1000)])
    tick(engine, Side.DOWN, w.open_ts + 31, 0.61, [(0.61, 1000)])

    engine.finalize_window(Side.UP)

    assert engine.next_shares == 500
    assert engine.total_losses == 1
    assert engine.total_pnl == 0.0
    assert engine.history[-1]["result"] == "LOSS_NO_TRADE"


def test_settlement_clears_position_and_realizes_pnl():
    engine = Engine(PaperBroker())
    w = window(37)
    engine.reset_for_window(w, Side.UP)
    tick(engine, Side.UP, w.open_ts + 1, 0.35, [(0.35, 1000)])
    engine.finalize_window(Side.UP)

    assert engine.s.position is None
    assert engine.snapshot()["unrealized_pnl"] == 0.0
    assert engine.snapshot()["equity"] == engine.snapshot()["cash_balance"]
    assert engine.snapshot()["realized_pnl"] == 325.0


def test_live_mark_to_market_equity():
    engine = Engine(PaperBroker())
    w = window(40)
    engine.reset_for_window(w, Side.UP)
    engine.on_tick(
        0.30, 0.35, 0.20, 0.80,
        now=w.open_ts + 1,
        up_ask_levels=[(0.35, 1000)],
        down_ask_levels=[(0.80, 1000)],
    )
    snapshot = engine.snapshot()
    assert snapshot["cash_balance"] == 1825.0
    assert snapshot["position"]["mark_price"] == 0.30
    assert snapshot["position"]["market_value"] == 150.0
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
    assert snapshot["unrealized_pnl"] == 55.0
    assert snapshot["equity"] == 2055.0


if __name__ == "__main__":
    test_win_progression_and_direction_reset()
    test_loss_resets_and_binary_payout()
    test_limit_order_stays_active_for_full_window()
    test_no_fill_winner_reduces_progression_without_pnl()
    test_no_fill_loss_resets_progression_without_pnl()
    test_settlement_clears_position_and_realizes_pnl()
    test_live_mark_to_market_equity()
    print("ENGINE TESTS PASSED")