import importlib.util
from pathlib import Path
import unittest
import tempfile
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

    def test_unreachable_calibrated_threshold_is_observation_only(self):
        payload = {"coef": .058875, "intercept": -1.051367, "metrics": {}}
        self.assertEqual(m.ready_status(payload), "OBSERVING_LOW_CONFIDENCE")
        self.assertFalse(m.describe(payload)["metrics"]["thresholdReachable"])
        self.assertLess(m.describe(payload)["metrics"]["scoreUpperBound"], .4)

    def history(self, at, count=481):
        history = m.CandleHistory(tempfile.mkdtemp())
        last = at // 60000 * 60000 - 60000
        history.buckets["live"] = {
            last - i * 60000: [last - i * 60000, 60000 + i * .2,
                              last - i * 60000 + 59999]
            for i in range(count)}
        return history

    def test_eight_hour_features_exclude_forming_and_future_candles(self):
        at = 1800000000000
        history = self.history(at)
        before, through = history.vector(at)
        self.assertEqual(len(before), 11)
        self.assertLess(through, at)
        history.buckets["live"][at] = [at, 9000000, at + 59999]
        after, _ = history.vector(at)
        np.testing.assert_allclose(before, after)
        self.assertAlmostEqual(before[5], abs(np.log(60000 / (60000 + 480 * .2))))

    def test_short_gapped_or_stale_history_is_rejected(self):
        at = 1800000000000
        with self.assertRaises(ValueError):
            self.history(at, 480).vector(at)
        history = self.history(at)
        del history.buckets["live"][at - 100 * 60000]
        with self.assertRaises(ValueError):
            history.vector(at)
        with self.assertRaises(ValueError):
            self.history(at).vector(at + 120001)

    def test_legacy_examples_are_enriched_without_rewriting_them(self):
        at = 1800000150000
        history = self.history(at)
        base = [0.] * 15
        base[1] = .5
        row = {"windowStart": 1800000000000, "features": base, "y": 1, "source": "LIVE_CLOB"}
        enriched, missing = m.enrich([row], history)
        self.assertEqual(m.example_at(row), at)
        self.assertEqual(missing, 0)
        self.assertEqual(len(enriched[0]["features"]), 26)
        self.assertEqual(len(row["features"]), 15)
        self.assertEqual(enriched[0]["y"], row["y"])
        extended, _ = m.enrich(enriched, history)
        self.assertEqual(len(extended[0]["features"]), 26)

    def test_downloader_paginates_caches_and_uses_completed_bars_only(self):
        from urllib.parse import parse_qs, urlparse
        requests = []
        def download(url):
            query = parse_qs(urlparse(url).query)
            start, end = int(query["startTime"][0]), int(query["endTime"][0])
            requests.append(start)
            return [[t, 1, 1, 1, 60000, 1, t + 59999] for t in
                    range(start, min(end + 1, start + 1000 * 60000), 60000)]
        with tempfile.TemporaryDirectory() as directory:
            h = m.CandleHistory(directory, download)
            h.ensure(0, 1500 * 60000 + 5000)
            self.assertEqual(len(requests), 2)
            self.assertEqual(len(h.buckets["live"]), 1500)
            h.ensure(0, 1500 * 60000 + 5000)
            self.assertEqual(len(requests), 2)
            self.assertEqual(len(m.CandleHistory(directory).buckets["live"]), 1500)

    def test_unseen_test_labels_cannot_change_selected_model_or_calibration(self):
        rows = []
        for i in range(160):
            vector = [0.] * 26
            vector[0], vector[1] = np.sin(i * .3), np.cos(i * .2)
            rows.append({"features": vector, "y": int(vector[0] > 0),
                         "windowStart": i * 300000, "source": "PUBLIC_SAMPLE"})
        first = m.fit(rows)
        changed = [{**e, "y": 1 - e["y"]} if e["windowStart"] >= 128 * 300000 else e
                   for e in rows]
        second = m.fit(changed)
        for key in ("algorithm", "calibrationMethod", "coef", "intercept", "booster", "linear"):
            self.assertEqual(first.get(key), second.get(key), key)
        self.assertLess(first["metrics"]["lastTrainingWindow"], first["metrics"]["firstTestWindow"])
        self.assertEqual(first["metrics"]["testExamples"], 32)

    def test_no_validated_edge_warning_is_explicit(self):
        payload = {"coef": 1, "intercept": 0,
                   "metrics": {"testBrier": .3, "baselineBrier": .2}}
        self.assertIn("no validated trading edge", m.describe(payload)["entryReadiness"])


if __name__ == "__main__":
    unittest.main()
