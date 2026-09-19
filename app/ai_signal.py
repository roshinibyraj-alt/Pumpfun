"""Directional multi-timeframe prediction engine.

The strategy does not fade its prediction. It builds a feature vector from
completed 1D, 4H, 1H and 15M BTC candles, combines a transparent indicator
score with an online logistic model, and predicts the direction of the next
5-minute window. The online model is walk-forward trained by app/backtest.py
on the latest week and then updated after every live window.

No future candle is used: higher-timeframe bars are aggregated only when
their final 1-minute candle has closed before the decision boundary.
"""
import math
from dataclasses import dataclass
from typing import Optional

from . import config
from .binance_client import BinanceKlineFeed, Candle
from .models import Side

TIMEFRAMES = {
    "1d": 86_400,
    "4h": 14_400,
    "1h": 3_600,
    "15m": 900,
}
TIMEFRAME_WEIGHTS = {"1d": 0.35, "4h": 0.30, "1h": 0.20, "15m": 0.15}
INDICATOR_NAMES = (
    "ema_alignment", "rsi_centered", "macd_hist", "adx",
    "momentum_3", "momentum_10", "bb_position", "atr_pct",
    "volume_ratio", "candle_body",
)
FEATURE_NAMES = [
    f"{timeframe}_{indicator}"
    for timeframe in TIMEFRAMES
    for indicator in INDICATOR_NAMES
]
N_FEATURES = len(FEATURE_NAMES)


@dataclass
class SignalFeatures:
    values: list
    details: dict
    regime: str
    rule_score: float
    alignment: float
    as_of_ts: float
    dominant_timeframe: str
    reason: str = ""

    def __len__(self):
        return len(self.values)

    def __iter__(self):
        return iter(self.values)


@dataclass
class _RunningStat:
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0

    def update(self, x: float):
        self.n += 1
        delta = x - self.mean
        self.mean += delta / self.n
        self.m2 += delta * (x - self.mean)

    def normalize(self, x: float) -> float:
        if self.n < 2:
            return 0.0
        variance = self.m2 / (self.n - 1)
        std = math.sqrt(variance) if variance > 1e-9 else 1.0
        return (x - self.mean) / std


def _clamp(value: float, low: float = -1.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    ez = math.exp(z)
    return ez / (1.0 + ez)


def _ema(values: list, period: int) -> float:
    if not values:
        return 0.0
    alpha = 2.0 / (period + 1.0)
    result = values[0]
    for value in values[1:]:
        result = alpha * value + (1.0 - alpha) * result
    return result


def _rsi(closes: list, period: int = 14) -> float:
    if len(closes) < 2:
        return 50.0
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    changes = changes[-period:]
    gains = sum(max(change, 0.0) for change in changes)
    losses = sum(max(-change, 0.0) for change in changes)
    if losses <= 1e-12:
        return 100.0 if gains > 0 else 50.0
    return 100.0 - (100.0 / (1.0 + gains / losses))


def _atr(bars: list, period: int = 14) -> float:
    true_ranges = []
    previous_close = None
    for bar in bars:
        high = bar.high if bar.high is not None else max(bar.open, bar.close)
        low = bar.low if bar.low is not None else min(bar.open, bar.close)
        if previous_close is None:
            true_ranges.append(high - low)
        else:
            true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        previous_close = bar.close
    recent = true_ranges[-period:]
    return sum(recent) / len(recent) if recent else 0.0


def _indicator_snapshot(bars: list) -> Optional[dict]:
    if len(bars) < config.AI_MIN_BARS_PER_TIMEFRAME:
        return None
    closes = [bar.close for bar in bars]
    volumes = [bar.volume for bar in bars]
    current = bars[-1]
    price = max(abs(current.close), 1e-9)

    ema9 = _ema(closes, 9)
    ema21 = _ema(closes, 21)
    ema50 = _ema(closes, 50)
    atr = _atr(bars, 14)
    atr_pct = atr / price * 100.0
    scale = max(atr, price * 0.0001)

    ema_order = 1.0 if ema9 > ema21 > ema50 else (-1.0 if ema9 < ema21 < ema50 else 0.0)
    if ema_order == 0.0:
        ema_order = math.tanh((ema9 - ema21) / scale) * 0.7 + math.tanh((ema21 - ema50) / scale) * 0.3

    ema12 = _ema(closes, 12)
    ema26 = _ema(closes, 26)
    macd = ema12 - ema26
    macd_values = []
    for i in range(max(0, len(closes) - 40), len(closes)):
        prefix = closes[:i + 1]
        macd_values.append(_ema(prefix, 12) - _ema(prefix, 26))
    macd_signal = _ema(macd_values, 9) if macd_values else macd
    macd_hist = math.tanh((macd - macd_signal) / scale)

    rsi = _rsi(closes, 14)
    rsi_centered = _clamp((rsi - 50.0) / 25.0)
    momentum_3 = ((closes[-1] / closes[-4]) - 1.0) * 100.0 if len(closes) >= 4 else 0.0
    momentum_10 = ((closes[-1] / closes[-11]) - 1.0) * 100.0 if len(closes) >= 11 else 0.0
    momentum_score = math.tanh((momentum_3 * 0.65 + momentum_10 * 0.35) / 0.35)

    bb_window = closes[-20:]
    bb_mean = sum(bb_window) / len(bb_window)
    bb_std = math.sqrt(sum((x - bb_mean) ** 2 for x in bb_window) / len(bb_window)) if bb_window else 0.0
    bb_position = _clamp((closes[-1] - bb_mean) / max(2.0 * bb_std, price * 0.0001))

    adx = _adx(bars, 14)
    direction = 1.0 if ema_order >= 0 else -1.0
    adx_direction = direction * _clamp(adx / 35.0, 0.0, 1.0)
    volume_avg = sum(volumes[-20:]) / max(1, len(volumes[-20:]))
    volume_ratio = _clamp((volumes[-1] / max(volume_avg, 1e-9) - 1.0) / 2.0)
    body = (current.close - current.open) / price

    # A transparent score used alongside the learned model. Higher timeframes
    # carry more weight, while ADX only strengthens an already directional trend.
    score = _clamp(
        0.26 * ema_order
        + 0.20 * macd_hist
        + 0.15 * rsi_centered
        + 0.15 * momentum_score
        + 0.12 * adx_direction
        + 0.07 * bb_position
        + 0.05 * (volume_ratio * (1.0 if momentum_score >= 0 else -1.0))
    )

    return {
        "bars": len(bars),
        "close": round(current.close, 2),
        "ema9": round(ema9, 2),
        "ema21": round(ema21, 2),
        "ema50": round(ema50, 2),
        "ema_alignment": round(ema_order, 4),
        "rsi": round(rsi, 2),
        "rsi_centered": round(rsi_centered, 4),
        "macd": round(macd, 4),
        "macd_signal": round(macd_signal, 4),
        "macd_hist": round(macd_hist, 4),
        "adx": round(adx, 2),
        "momentum_3": round(momentum_3, 4),
        "momentum_10": round(momentum_10, 4),
        "bb_position": round(bb_position, 4),
        "atr_pct": round(atr_pct, 4),
        "volume_ratio": round(volume_ratio, 4),
        "candle_body": round(body, 5),
        "score": round(score, 4),
    }


def _adx(bars: list, period: int = 14) -> float:
    if len(bars) < period + 1:
        return 0.0
    trs, plus_dm, minus_dm = [], [], []
    previous = bars[0]
    for bar in bars[1:]:
        high = bar.high if bar.high is not None else max(bar.open, bar.close)
        low = bar.low if bar.low is not None else min(bar.open, bar.close)
        previous_high = previous.high if previous.high is not None else max(previous.open, previous.close)
        previous_low = previous.low if previous.low is not None else min(previous.open, previous.close)
        previous_close = previous.close
        trs.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        up_move = high - previous_high
        down_move = previous_low - low
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        previous = bar
    trs, plus_dm, minus_dm = trs[-period:], plus_dm[-period:], minus_dm[-period:]
    tr_sum = sum(trs)
    if tr_sum <= 1e-12:
        return 0.0
    plus_di = 100.0 * sum(plus_dm) / tr_sum
    minus_di = 100.0 * sum(minus_dm) / tr_sum
    return 100.0 * abs(plus_di - minus_di) / max(plus_di + minus_di, 1e-9)


class AISignalEngine:
    """Walk-forward learner plus interpretable multi-timeframe scoring."""

    def __init__(self):
        self.weights = [0.0] * N_FEATURES
        self.bias = 0.0
        self.stats = [_RunningStat() for _ in range(N_FEATURES)]
        self.n_trained = 0
        self.pretrained_windows = 0
        self.total_predictions = 0
        self.correct_predictions = 0
        self.last_prediction: Optional[dict] = None
        self.backtest: dict = {}

    def compute_features(self, feed: BinanceKlineFeed, signal_open_ts: float) -> Optional[SignalFeatures]:
        """Build features using only completed bars available at the decision."""
        as_of_ts = signal_open_ts + 60.0
        details = {}
        values = []
        scores = {}
        for timeframe, seconds in TIMEFRAMES.items():
            bars = feed.get_timeframe_bars(
                seconds, as_of_ts, min_bars=config.AI_MIN_BARS_PER_TIMEFRAME,
            )
            snapshot = _indicator_snapshot(bars) if bars else None
            if snapshot is None:
                return None
            details[timeframe] = snapshot
            scores[timeframe] = snapshot["score"]
            values.extend(snapshot[name] for name in INDICATOR_NAMES)

        rule_score = _clamp(sum(TIMEFRAME_WEIGHTS[k] * scores[k] for k in TIMEFRAMES))
        dominant_timeframe = max(TIMEFRAMES, key=lambda key: abs(scores[key]) * TIMEFRAME_WEIGHTS[key])
        alignment = _clamp(1.0 - sum(
            TIMEFRAME_WEIGHTS[k] * abs(scores[k] - rule_score) for k in TIMEFRAMES
        ))
        htf_score = 0.55 * scores["1d"] + 0.45 * scores["4h"]
        htf_adx = 0.5 * details["1d"]["adx"] + 0.5 * details["4h"]["adx"]
        if abs(htf_score) >= 0.25 and htf_adx >= 22 and (
            htf_score * rule_score >= 0 or abs(rule_score) < 0.12
        ):
            regime = "TREND_UP" if htf_score > 0 else "TREND_DOWN"
        elif abs(rule_score) < 0.12:
            regime = "RANGE"
        else:
            regime = "TRANSITION"

        signed = "UP" if rule_score >= 0 else "DOWN"
        leaders = sorted(
            ((key, scores[key] * TIMEFRAME_WEIGHTS[key]) for key in TIMEFRAMES),
            key=lambda item: abs(item[1]),
            reverse=True,
        )
        leader_text = ", ".join(f"{key} {value:+.2f}" for key, value in leaders[:2])
        reason = (
            f"{regime}: {signed} multi-timeframe score {rule_score:+.3f}, "
            f"alignment {alignment:.2f}; strongest evidence {leader_text}"
        )
        return SignalFeatures(
            values=values,
            details=details,
            regime=regime,
            rule_score=rule_score,
            alignment=alignment,
            as_of_ts=as_of_ts,
            dominant_timeframe=dominant_timeframe,
            reason=reason,
        )

    @staticmethod
    def _values(feats) -> Optional[list]:
        if feats is None:
            return None
        return feats.values if isinstance(feats, SignalFeatures) else feats

    def _standardize(self, feats) -> list:
        values = self._values(feats)
        return [self.stats[i].normalize(values[i]) for i in range(N_FEATURES)]

    def _model_probability(self, feats) -> float:
        x = self._standardize(feats)
        z = self.bias + sum(weight * value for weight, value in zip(self.weights, x))
        return _sigmoid(max(-8.0, min(8.0, z)))

    def predict(self, feats: Optional[SignalFeatures]):
        """Return the directional prediction and confidence.

        The model probability is blended with the transparent indicator score.
        This keeps predictions explainable during early training and lets the
        walk-forward learner take over as evidence accumulates.
        """
        if feats is None:
            self.last_prediction = None
            return None, None
        model_p_up = self._model_probability(feats)
        rule_p_up = 0.5 + 0.25 * feats.rule_score
        p_up = _clamp(
            config.AI_MODEL_WEIGHT * model_p_up
            + (1.0 - config.AI_MODEL_WEIGHT) * rule_p_up,
            0.02, 0.98,
        )
        side = Side.UP if p_up >= 0.5 else Side.DOWN
        confidence = p_up if side == Side.UP else 1.0 - p_up
        self.last_prediction = {
            "side": side.value,
            "p_up": round(p_up, 4),
            "confidence": round(confidence, 4),
            "model_p_up": round(model_p_up, 4),
            "rule_score": round(feats.rule_score, 4),
            "alignment": round(feats.alignment, 4),
            "regime": feats.regime,
            "dominant_timeframe": feats.dominant_timeframe,
            "reason": feats.reason,
            "timeframes": feats.details,
        }
        return side, confidence

    def is_tradeable(self, confidence: Optional[float], feats: Optional[SignalFeatures]) -> bool:
        if confidence is None or feats is None:
            return False
        return (
            confidence >= config.AI_MIN_CONFIDENCE
            and feats.alignment >= config.AI_MIN_ALIGNMENT
        )

    def learn(self, feats, actual_up: bool, pretrain: bool = False):
        values = self._values(feats)
        if values is None or len(values) != N_FEATURES:
            return
        for i, raw in enumerate(values):
            self.stats[i].update(raw)
        x = self._standardize(feats)
        p = self._model_probability(feats)
        error = p - (1.0 if actual_up else 0.0)
        for i in range(N_FEATURES):
            gradient = error * x[i] + config.AI_L2_REG * self.weights[i]
            self.weights[i] -= config.AI_LEARNING_RATE * gradient
        self.bias -= config.AI_LEARNING_RATE * error
        self.n_trained += 1
        if pretrain:
            self.pretrained_windows += 1

    def record_prediction_result(self, predicted_side: Optional[Side], actual_up: bool):
        if predicted_side is None:
            return
        self.total_predictions += 1
        if predicted_side == (Side.UP if actual_up else Side.DOWN):
            self.correct_predictions += 1

    def set_backtest_summary(self, summary: dict):
        self.backtest = summary or {}

    def status(self) -> dict:
        accuracy = (
            round(100 * self.correct_predictions / self.total_predictions, 1)
            if self.total_predictions else None
        )
        return {
            "n_trained": self.n_trained,
            "pretrained_windows": self.pretrained_windows,
            "live_trained_windows": self.n_trained - self.pretrained_windows,
            "total_predictions": self.total_predictions,
            "correct_predictions": self.correct_predictions,
            "accuracy": accuracy,
            "weights": dict(zip(FEATURE_NAMES, [round(w, 4) for w in self.weights])),
            "bias": round(self.bias, 4),
            "min_confidence": config.AI_MIN_CONFIDENCE,
            "min_alignment": config.AI_MIN_ALIGNMENT,
            "last_prediction": self.last_prediction,
            "backtest": self.backtest,
        }