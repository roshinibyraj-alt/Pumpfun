"""Regression tests for the signal-to-entry side mapping."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import config
from app.engine import entry_side_for_signal
from app.models import Side


original = config.FADE_SIGNAL
try:
    config.FADE_SIGNAL = True
    assert entry_side_for_signal(Side.UP) == Side.DOWN
    assert entry_side_for_signal(Side.DOWN) == Side.UP

    config.FADE_SIGNAL = False
    assert entry_side_for_signal(Side.UP) == Side.UP
    assert entry_side_for_signal(Side.DOWN) == Side.DOWN
finally:
    config.FADE_SIGNAL = original

print("signal-to-entry side mapping ok")