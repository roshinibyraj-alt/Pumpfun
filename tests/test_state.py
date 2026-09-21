"""Regression tests for final-second CLOB winner confirmation."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.models import Side
from app.state import BotState


def test_winner_threshold():
    state = BotState()
    state.final_second_up = 0.96
    state.final_second_down = 0.04
    assert state._resolve_final_winner() == Side.UP
    state.final_second_up = 0.04
    state.final_second_down = 0.96
    assert state._resolve_final_winner() == Side.DOWN


def test_unresolved_window():
    state = BotState()
    state.final_second_up = 0.94
    state.final_second_down = 0.06
    assert state._resolve_final_winner() is None
    state.final_second_up = None
    assert state._resolve_final_winner() is None


if __name__ == "__main__":
    test_winner_threshold()
    test_unresolved_window()
    print("STATE TESTS PASSED")