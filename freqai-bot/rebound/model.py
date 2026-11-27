"""Independent, experimental rebound classifier; never a settlement-direction model."""
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.request

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

SCHEMA = "rebound-causal-price-v1"
SAMPLE_URL = ("https://huggingface.co/philippotiger/btc-5min-polymarket-predictor/"
              "resolve/d5a00868813b0caac15ece75bad82e3424cb689d/sample_data/sample.csv")
FEATURES = ["mid", "secs_norm", "spread", "price_from_open", "dist_from_low",
            "mom_5s", "mom_30s", "mom_accel", "volatility_30s",
            "up_ratio_5", "up_ratio_10", "streak_dir", "streak_len",
            "btc_abs_delta", "btc_abs_mom_30s"]


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
    if len(out) != len(FEATURES) or not np.all(np.isfinite(out)):
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
                    examples.append({"features": vector, "y": int(max(future, default=0) >= .75),
                                     "windowStart": end - 300000, "source": "PUBLIC_SAMPLE",
                                     "horizonGapMs": end - records[-1]["ts"] * 1000})
                except (ValueError, TypeError):
                    pass
                break
    return examples


def fit(examples):
    # Keep every side from one window in the same fold, in chronological order.
    windows = sorted(set(e["windowStart"] for e in examples))
    if len(windows) < 100:
        raise ValueError("At least 100 independent labeled windows are required")
    a, b = int(.6 * len(windows)), int(.8 * len(windows))
    folds = [[e for e in examples if predicate(e["windowStart"])] for predicate in (
        lambda t: t < windows[a - 1],
        lambda t: windows[a] <= t < windows[b - 1],
        lambda t: t >= windows[b])]
    if any(len(set(e["y"] for e in fold)) < 2 for fold in folds):
        raise ValueError("Train, calibration and untouched test folds need both outcomes")
    arrays = [(np.asarray([e["features"] for e in f]), np.asarray([e["y"] for e in f]))
              for f in folds]
    (x, y), (cx, cy), (tx, ty) = arrays
    model = lgb.LGBMClassifier(n_estimators=80, learning_rate=.035, num_leaves=6,
                              max_depth=3, min_child_samples=10, reg_lambda=5,
                              random_state=42, n_jobs=1, verbosity=-1)
    model.fit(x, y)  # Never use the test set for early stopping or threshold tuning.
    logit = lambda p: np.log(np.clip(p, .0001, .9999) / (1 - np.clip(p, .0001, .9999))).reshape(-1, 1)
    calibrator = LogisticRegression(C=1, random_state=42).fit(logit(model.predict_proba(cx)[:, 1]), cy)
    proba = calibrator.predict_proba(logit(model.predict_proba(tx)[:, 1]))[:, 1]
    signals = proba >= .63
    metrics = {"trainExamples": len(y), "calibrationExamples": len(cy), "testExamples": len(ty),
               "testAuc": float(roc_auc_score(ty, proba)),
               "testBrier": float(brier_score_loss(ty, proba)),
               "baselineBrier": float(brier_score_loss(ty, np.full(len(ty), float(y.mean())))),
               "testPrecision": float(ty[signals].mean()) if signals.any() else None,
               "testSignals": int(signals.sum()),
               "labelSource": "Observed rebound, not settlement. Public bootstrap ends about 8s before expiry (censored proxy); live examples cover expiry.",
               "split": "Chronological 60/20/20 by whole window, one-window embargo, untouched test",
               "experimental": True, "publicExamples": sum(e["source"] == "PUBLIC_SAMPLE" for e in examples),
               "liveExamples": sum(e["source"] == "LIVE_CLOB" for e in examples)}
    return {"schema": SCHEMA, "featureNames": FEATURES,
            "booster": model.booster_.model_to_string(), "coef": float(calibrator.coef_[0, 0]),
            "intercept": float(calibrator.intercept_[0]), "trainedAt": int(time.time() * 1000),
            "version": f"{SCHEMA}-{int(time.time())}", "metrics": metrics}


def predict(payload, vector):
    booster = lgb.Booster(model_str=payload["booster"])
    p = float(np.clip(booster.predict(np.asarray([vector]), num_threads=1)[0], .0001, .9999))
    z = payload["coef"] * math.log(p / (1 - p)) + payload["intercept"]
    return 1 / (1 + math.exp(-max(-700, min(700, z))))


def describe(payload):
    description = {k: v for k, v in payload.items() if k != "booster"}
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
    return description


def ready_status(payload):
    return "READY_EXPERIMENTAL" if describe(payload)["metrics"]["thresholdReachable"] else "OBSERVING_LOW_CONFIDENCE"


def emit(row):
    print(json.dumps(row, allow_nan=False), flush=True)


def main():
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    model_path, sample_path = directory / "model.json", directory / "sample.csv"
    payload = None
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
        if payload is None or time.time() * 1000 - payload["trainedAt"] > 21600000:
            live_path = directory / "training.json"
            live = json.loads(live_path.read_text()) if live_path.exists() else []
            payload = fit(public + live)
            payload["sampleSha256"] = hashlib.sha256(sample_path.read_bytes()).hexdigest()
            temp = model_path.with_suffix(".tmp")
            temp.write_text(json.dumps(payload, allow_nan=False))
            temp.replace(model_path)
        emit({"type": "model", "model": describe(payload), "status": ready_status(payload)})
    except Exception as error:
        emit({"type": "status", "status": ready_status(payload) if payload else "ERROR",
              "lastError": str(error)})
        if payload:
            emit({"type": "model", "model": describe(payload), "status": ready_status(payload)})
    for line in sys.stdin:
        try:
            message = json.loads(line)
            vector = features(message["context"])
            probability = predict(payload, vector) if payload else None
            emit({"type": "score", "id": message["id"], "features": vector,
                  "probability": probability, "version": payload["version"] if payload else None})
        except Exception as error:
            emit({"type": "score", "id": message.get("id") if "message" in locals() else None,
                  "probability": None, "lastError": str(error)})


if __name__ == "__main__":
    main()
