import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("rebound", Path(__file__).parents[1] / "rebound/model.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ReboundModelTests(unittest.TestCase):
    def context(self):
        return {"at": 32000, "end": 300000, "openMid": .5, "low": .3, "btcOpen": 60000,
                "points": [{"at": i * 1000, "mid": .5 - i / 160, "spread": .01,
                            "btcPrice": 60000 + i} for i in range(33)]}

    def test_features_are_causal_and_finite(self):
        vector = m.features(self.context())
        self.assertEqual(len(vector), 15)
        self.assertTrue(np.all(np.isfinite(vector)))
        self.assertAlmostEqual(vector[5], -.03125)

    def test_future_or_missing_prices_are_rejected(self):
        c = self.context()
        c["points"][-1]["at"] += 1000
        with self.assertRaises(ValueError):
            m.features(c)
        c = self.context()
        c["points"][-1]["btcPrice"] = None
        with self.assertRaises(ValueError):
            m.features(c)

    def test_training_needs_independent_windows_and_both_classes(self):
        with self.assertRaises(ValueError):
            m.fit([{"windowStart": 0, "features": [0] * 15, "y": 1} for _ in range(200)])


if __name__ == "__main__":
    unittest.main()
