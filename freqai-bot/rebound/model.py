"""Independent, experimental rebound classifier; never a settlement-direction model."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import urllib.request

import numpy as np
import pandas as pd
sys.path.insert(0, str(Path(__file__).parent))
from context_history import CandleHistory, LONG_FEATURES
from learning import fit as fit_pipeline, score as score_pipeline

SCHEMA = "rebound-context8h-walkforward-v2"
SAMPLE_URL = ("https://huggingface.co/philippotiger/btc-5min-polymarket-predictor/"
              "resolve/d5a00868813b0caac15ece75bad82e3424cb689d/sample_data/sample.csv")
BASE_FEATURES = ["mid", "secs_norm", "spread", "price_from_open", "dist_from_low",
            "mom_5s", "mom_30s", "mom_accel", "volatility_30s",
            "up_ratio_5", "up_ratio_10", "streak_dir", "streak_len",
            "btc_abs_delta", "btc_abs_mom_30s"]
FEATURES = BASE_FEATURES + LONG_FEATURES
OUTPUT_LOCK = threading.Lock()


def features(context):
    points = context["points"]
    now = context["at"]
    if not points or any(p["at"] > now for p in points):
        raise ValueError("Features require causal observations only")
    p = points[-1]
    if not 0 < p["mid"] < 1 or p["btcPrice"] is None or context["btcOpen"] <= 0:
        raise ValueError("Missing valid token/BTC prices")
    def past(ms):
        return next((x for x in reversed(points) if x["at"] <= now - ms), points[0])
    recent = [x for x in points if x["at"] >= now - 30000]
    changes = np.diff([x["mid"] for x in points])
    m5, m30 = p["mid"] - past(5000)["mid"], p["mid"] - past(30000)["mid"]
    direction = int(np.sign(changes[-1])) if len(changes) else 0
    streak = 0
    for change in reversed(changes):
        if int(np.sign(change)) != direction:
            break
        streak += 1
    ratio = lambda n: float(np.mean(changes[-n:] > 0)) if len(changes) else 0.5
    previous_btc = past(30000).get("btcPrice") or p["btcPrice"]
    out = [p["mid"], max(0, (context["end"] - now) / 300000), p["spread"],
           p["mid"] - context["openMid"], p["mid"] - context["low"],
           m5, m30, m5 - m30,
           float(np.std(np.diff([x["mid"] for x in recent]))) if len(recent) > 1 else 0,
           ratio(5), ratio(10), direction, min(streak, 300),
           abs(math.log(p["btcPrice"] / context["btcOpen"])),
           abs(math.log(p["btcPrice"] / previous_btc))]
    if len(out) != len(BASE_FEATURES) or not np.all(np.isfinite(out)):
        raise ValueError("Invalid rebound features")
    return out


def bootstrap(path):
    """Reconstruct inputs and future labels; do not trust published book fields/labels."""
    df = pd.read_csv(path)
    examples = []
    for _, group in df.groupby("market_id"):
        group = group.sort_values("ts")
        group = group[(group.mid > 0) & (group.mid < 1) & (group.secs_norm > 0)]
        if group.empty:
            continue
        end = round(float(np.median(group.ts + group.secs_norm * 300)) / 300) * 300000
        if end - float(group.ts.iloc[-1]) * 1000 > 10000:
            continue
        # The public collector stops about eight seconds before expiry. Its
        # labels measure only the OBSERVED horizon, not unobserved final seconds.
        # This disclosed proxy is for experimental bootstrap only. Live negatives
        # below are collected with full through-expiry coverage.
        points, low = [], 1.0
        records = group.to_dict("records")
        for i, row in enumerate(records):
            point = {"at": row["ts"] * 1000, "mid": row["mid"],
                     "spread": row["spread"], "btcPrice": row["btc_price"]}
            points.append(point)
            low = min(low, point["mid"])
            if point["mid"] <= .35:
                try:
                    vector = features({"points": points, "at": point["at"], "end": end,
                                       "low": low, "openMid": points[0]["mid"],
                                       "btcOpen": records[0]["btc_open"]})
                    future = [r["mid"] for r in records[i:] if r["ts"] * 1000 < end]
                    examples.append({"features": vector, "at": point["at"],
                                     "y": int(max(future, default=0) >= .75),
                                     "windowStart": end - 300000, "source": "PUBLIC_SAMPLE",
                                     "horizonGapMs": end - records[-1]["ts"] * 1000})
                except (ValueError, TypeError):
                    pass
                break
    return examples


def fit(examples):
    result = fit_pipeline(examples, FEATURES, SCHEMA)
    result.update({"trainedAt": int(time.time() * 1000),
                   "version": f"{SCHEMA}-{int(time.time())}"})
    return result


def example_at(example):
    # Legacy vectors encode exact seconds remaining; this recovers their actual
    # first-dip timestamp rather than guessing the start of their window.
    return example.get("at", example["windowStart"] + 300000 - example["features"][1] * 300000)


def enrich(examples, history):
    enriched, missing = [], 0
    for example in examples:
        try:
            at = example_at(example)
            long_vector, _ = history.vector(at)
            base = example["features"][:len(BASE_FEATURES)]
            if len(base) != len(BASE_FEATURES) or not np.all(np.isfinite(base)):
                raise ValueError("Invalid legacy features")
            enriched.append({**example, "at": at, "features": base + long_vector})
        except (ValueError, KeyError, IndexError, TypeError):
            missing += 1
    return enriched, missing


def predict(payload, vector):
    return score_pipeline(payload, vector)[1]


def describe(payload):
    description = {k: v for k, v in payload.items() if k not in ("booster", "linear")}
    # Calibration may compress EVERY possible prediction below entry threshold.
    # Expose that explicitly, rather than imply that a silent bot is trade-ready.
    upper_z = abs(payload["coef"]) * math.log(9999) + payload["intercept"]
    upper = 1 / (1 + math.exp(-max(-700, min(700, upper_z))))
    description["metrics"] = {**payload["metrics"], "scoreUpperBound": upper,
                              "thresholdReachable": upper >= .63}
    description["entryReadiness"] = (
        "Scores can qualify; actual entries still require fresh prices and liquidity."
        if upper >= .63 else
        "Current calibrated model cannot reach the 63% entry threshold. Observation and automatic retraining continue; no forced trades.")
    metrics = payload["metrics"]
    if ("testBrier" in metrics and "baselineBrier" in metrics
            and metrics["testBrier"] >= metrics["baselineBrier"]):
        description["entryReadiness"] += " Untouched test does not beat the base-rate baseline; no validated trading edge."
    return description


def ready_status(payload):
    return "READY_EXPERIMENTAL" if describe(payload)["metrics"]["thresholdReachable"] else "OBSERVING_LOW_CONFIDENCE"


def emit(row):
    with OUTPUT_LOCK:
        print(json.dumps(row, allow_nan=False), flush=True)


def main():
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    model_path, sample_path = directory / "model.json", directory / "sample.csv"
    payload, history = None, CandleHistory(directory)
    refresh_thread = None
    try:
        if model_path.exists():
            cached = json.loads(model_path.read_text())
            if cached.get("schema") == SCHEMA:
                payload = cached
        emit({"type": "status", "status": "TRAINING"})
        if not sample_path.exists():
            # Bounded, public data download. Never download or unpickle third-party weights.
            temporary = sample_path.with_suffix(".download")
            with urllib.request.urlopen(SAMPLE_URL, timeout=30) as response, temporary.open("wb") as out:
                size = 0
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > 50 * 1024 * 1024:
                        raise ValueError("Public sample exceeds 50 MiB")
                    out.write(chunk)
            temporary.replace(sample_path)
        public = bootstrap(sample_path)
        live_path = directory / "training.json"
        live = json.loads(live_path.read_text()) if live_path.exists() else []
        now = int(time.time() * 1000)
        history.ensure(min(example_at(e) for e in public) - 9 * 3600000,
                       max(example_at(e) for e in public), "public")
        recent_live = [e for e in live if example_at(e) >= now - 30 * 86400000]
        oldest_live = min([example_at(e) for e in recent_live] + [now])
        history.ensure(min(oldest_live, now) - 9 * 3600000, now)
        latest_live = max([example_at(e) for e in live] + [0])
        if (payload is None or now - payload["trainedAt"] >= 3600000
                or len(live) != payload.get("inputLiveExamples")
                or latest_live != payload.get("latestInputLiveAt")):
            enriched, missing = enrich(public + recent_live, history)
            replacement = fit(enriched)
            replacement["inputLiveExamples"] = len(live)
            replacement["latestInputLiveAt"] = latest_live
            replacement["metrics"]["examplesMissingContext"] = missing
            replacement["metrics"]["olderLiveExamplesRetainedButExcluded"] = len(live) - len(recent_live)
            replacement["history"] = history.snapshot()
            payload = replacement
            payload["sampleSha256"] = hashlib.sha256(sample_path.read_bytes()).hexdigest()
            temp = model_path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, allow_nan=False))
            temp.replace(model_path)
        emit({"type": "model", "model": {**describe(payload), "history": history.snapshot()},
              "status": ready_status(payload)})
    except Exception as error:
        emit({"type": "status", "status": ready_status(payload) if payload else "ERROR",
              "lastError": str(error)})
        if payload:
            emit({"type": "model", "model": {**describe(payload), "lastTrainingError": str(error),
                                            "history": history.snapshot()},
                  "status": ready_status(payload)})
    for line in sys.stdin:
        base, message = None, {}
        try:
            message = json.loads(line)
            if message.get("type") == "refresh":
                if refresh_thread is None or not refresh_thread.is_alive():
                    def refresh():
                        history.refresh()
                        emit({"type": "history", "history": history.snapshot()})
                    refresh_thread = threading.Thread(target=refresh, daemon=True)
                    refresh_thread.start()
                continue
            vector = features(message["context"])
            base = list(vector)
            long_vector, history_at = history.vector(message["context"]["at"])
            vector += long_vector
            raw, probability = score_pipeline(payload, vector) if payload else (None, None)
            emit({"type": "score", "id": message["id"], "features": vector,
                  "probability": probability, "rawProbability": raw,
                  "calibrationMethod": payload.get("calibrationMethod") if payload else None,
                  "btcHistoryAsOf": history_at, "lookbackHours": 8,
                  "version": payload["version"] if payload else None})
        except Exception as error:
            emit({"type": "score", "id": message.get("id") if "message" in locals() else None,
                  "features": base,
                  "probability": None, "lastError": str(error)})


if __name__ == "__main__":
    main()
