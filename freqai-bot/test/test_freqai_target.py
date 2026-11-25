#!/usr/bin/env python3
"""Ensure completed-minute scores target the 5-minute window containing close."""

import sys
import unittest
from pathlib import Path

import pandas as pd

STRATEGIES = Path(__file__).resolve().parents[1] / "freqai" / "strategies"
sys.path.insert(0, str(STRATEGIES))
from FreqAIWindowStrategy import FreqAIWindowStrategy  # noqa: E402


class WindowTargetTests(unittest.TestCase):
    def test_label_tracks_candle_close_across_window_boundary(self):
        dates = pd.date_range("2026-01-01T00:00:00Z", periods=15, freq="1min")
        opens = []
        closes = []
        for base, final_close in ((100, 100.5), (200, 199.5), (300, 300.5)):
            for minute in range(5):
                opens.append(base + minute * 0.1)
                closes.append(final_close if minute == 4 else base + minute * 0.1 + 0.05)

        frame = pd.DataFrame({
            "date": dates,
            "open": opens,
            "close": closes,
        })
        strategy = FreqAIWindowStrategy.__new__(FreqAIWindowStrategy)
        result = strategy.set_freqai_targets(frame.copy(), {})
        labels = result["&-window-direction"]

        self.assertEqual(labels.iloc[0], "UP")
        self.assertEqual(labels.iloc[3], "UP")
        self.assertEqual(labels.iloc[4], "DOWN")
        self.assertEqual(labels.iloc[5], "DOWN")
        self.assertEqual(labels.iloc[8], "DOWN")
        self.assertEqual(labels.iloc[9], "UP")
        self.assertEqual(labels.iloc[13], "UP")
        self.assertTrue(pd.isna(labels.iloc[14]))


if __name__ == "__main__":
    unittest.main()
