"""Chronological candidate selection and out-of-fold probability calibration."""
import math
import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def logits(p):
    clipped = np.clip(p, .0001, .9999)
    return np.log(clipped / (1 - clipped)).reshape(-1, 1)


def adjusted(p, coef, intercept):
    z = np.clip(coef * logits(np.asarray(p)).ravel() + intercept, -700, 700)
    return 1 / (1 + np.exp(-z))


def estimator(kind):
    if kind == "lightgbm":
        return lgb.LGBMClassifier(n_estimators=100, learning_rate=.035, num_leaves=6,
                                 max_depth=3, min_child_samples=12, reg_lambda=3,
                                 random_state=42, n_jobs=1, verbosity=-1)
    return make_pipeline(StandardScaler(), LogisticRegression(C=.3, max_iter=1000,
                                                              random_state=42))


def calibration(p, y):
    if len(set(y)) < 2 or len(y) < 20:
        raise ValueError("Calibration needs both outcomes and at least 20 examples")
    lr = LogisticRegression(C=10, random_state=42).fit(logits(p), y)
    return float(lr.coef_[0, 0]), float(lr.intercept_[0])


def fit(examples, feature_names, schema):
    examples = sorted(examples, key=lambda e: (e["windowStart"], e.get("at", 0)))
    windows = sorted(set(e["windowStart"] for e in examples))
    if len(windows) < 100:
        raise ValueError("At least 100 independently labeled windows are required")
    boundary = int(len(windows) * .8)
    # One whole window of embargo before the untouched final test.
    train = [e for e in examples if e["windowStart"] < windows[boundary - 1]]
    test = [e for e in examples if e["windowStart"] >= windows[boundary]]
    if min(len(set(e["y"] for e in f)) for f in (train, test)) < 2:
        raise ValueError("Training and untouched test both require both outcomes")
    train_windows = sorted(set(e["windowStart"] for e in train))
    initial = max(45, int(len(train_windows) * .45))
    blocks = np.array_split(np.asarray(train_windows[initial:]), 3)
    candidates, oof_rows = [], {}
    for kind in ("lightgbm", "logistic"):
        predictions = []
        for block in blocks:
            if len(block) == 0:
                continue
            prior = [w for w in train_windows if w < block[0]]
            rows = [e for e in train if e["windowStart"] < prior[-1]]
            validation = [e for e in train if e["windowStart"] in set(block)]
            if len(set(e["y"] for e in rows)) < 2:
                raise ValueError("Expanding-window training needs both outcomes")
            model = estimator(kind)
            model.fit(np.asarray([e["features"] for e in rows]), [e["y"] for e in rows])
            raw = model.predict_proba(np.asarray([e["features"] for e in validation]))[:, 1]
            predictions.extend((e, float(p)) for e, p in zip(validation, raw))
        oof_windows = sorted(set(e["windowStart"] for e, _ in predictions))
        split_at = oof_windows[len(oof_windows) // 2]
        early = [(e, p) for e, p in predictions if e["windowStart"] < split_at]
        late = [(e, p) for e, p in predictions if e["windowStart"] > split_at]
        if len(early) < 20 or len(late) < 15:
            raise ValueError("Too few chronological examples for calibration comparison")
        ep, ey = np.asarray([p for _, p in early]), np.asarray([e["y"] for e, _ in early])
        vp, vy = np.asarray([p for _, p in late]), np.asarray([e["y"] for e, _ in late])
        methods = [("identity", 1., 0.)]
        if len(set(ey)) == 2:
            a, b = calibration(ep, ey)
            methods.append(("sigmoid", a, b))
        for name, a, b in methods:
            candidates.append({"algorithm": kind, "calibration": name,
                               "validationBrier": float(brier_score_loss(vy, adjusted(vp, a, b))),
                               "selectionExamples": len(vy)})
        oof_rows[kind] = predictions
    chosen = min(candidates, key=lambda c: c["validationBrier"])
    selected = oof_rows[chosen["algorithm"]]
    op, oy = np.asarray([p for _, p in selected]), np.asarray([e["y"] for e, _ in selected])
    a, b = calibration(op, oy) if chosen["calibration"] == "sigmoid" else (1., 0.)
    x, y = np.asarray([e["features"] for e in train]), np.asarray([e["y"] for e in train])
    tx, ty = np.asarray([e["features"] for e in test]), np.asarray([e["y"] for e in test])
    final = estimator(chosen["algorithm"])
    final.fit(x, y)
    raw = final.predict_proba(tx)[:, 1]
    predicted = adjusted(raw, a, b)
    signals = predicted >= .63
    artifact = {"schema": schema, "featureNames": feature_names,
                "algorithm": chosen["algorithm"], "calibrationMethod": chosen["calibration"],
                "coef": a, "intercept": b, "lookbackHours": 8}
    if chosen["algorithm"] == "lightgbm":
        artifact["booster"] = final.booster_.model_to_string()
    else:
        scaler, classifier = final.steps[0][1], final.steps[1][1]
        artifact["linear"] = {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                              "coef": classifier.coef_[0].tolist(),
                              "intercept": float(classifier.intercept_[0])}
    artifact["metrics"] = {
        "trainExamples": len(train), "calibrationExamples": len(selected),
        "modelSelectionExamples": chosen["selectionExamples"], "testExamples": len(test),
        "testAuc": float(roc_auc_score(ty, predicted)),
        "testBrier": float(brier_score_loss(ty, predicted)),
        "rawTestBrier": float(brier_score_loss(ty, raw)),
        "baselineBrier": float(brier_score_loss(ty, np.full(len(ty), float(y.mean())))),
        "testPrecision": float(ty[signals].mean()) if signals.any() else None,
        "testSignals": int(signals.sum()), "validationBrier": chosen["validationBrier"],
        "candidates": candidates, "experimental": True,
        "split": "Expanding-window out-of-fold model/calibration selection; final 20% untouched; whole-window embargoes",
        "labelSource": "Observed rebound, not settlement. Public bootstrap ends about 8s early; live labels require observed expiry coverage.",
        "publicExamples": sum(e["source"] == "PUBLIC_SAMPLE" for e in examples),
        "liveExamples": sum(e["source"] == "LIVE_CLOB" for e in examples),
        "trainingLiveExamples": sum(e["source"] == "LIVE_CLOB" for e in train),
        "testLiveExamples": sum(e["source"] == "LIVE_CLOB" for e in test),
        "lastTrainingWindow": max(e["windowStart"] for e in train),
        "firstTestWindow": min(e["windowStart"] for e in test),
    }
    return artifact


def score(payload, vector):
    if payload["algorithm"] == "lightgbm":
        raw = float(lgb.Booster(model_str=payload["booster"]).predict(
            np.asarray([vector]), num_threads=1)[0])
    else:
        linear = payload["linear"]
        standardized = (np.asarray(vector) - np.asarray(linear["mean"])) / np.asarray(linear["scale"])
        z = float(standardized @ np.asarray(linear["coef"]) + linear["intercept"])
        raw = 1 / (1 + math.exp(-max(-700, min(700, z))))
    return raw, float(adjusted([raw], payload["coef"], payload["intercept"])[0])
