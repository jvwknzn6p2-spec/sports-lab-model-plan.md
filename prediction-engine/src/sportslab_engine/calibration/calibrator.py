"""Probability calibration (Component 3).

A GBM's raw ``predict_proba`` is often mis-calibrated — when it says 70% the true
frequency might be 63%. This fits an isotonic regression mapping raw → empirical
probability on a held-out split, so a published "60%" pick actually wins ~60% of
the time. That property is exactly what the backtest/error-analysis stage and the
Risk Reviewer rely on.

The calibrator is a pure function once fitted; it persists via pickle and falls
back to identity when unfitted so the pipeline still runs before the first
calibration.
"""

from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np
from sklearn.isotonic import IsotonicRegression


class ProbabilityCalibrator:
    def __init__(self, iso: IsotonicRegression | None = None):
        self._iso = iso

    @property
    def fitted(self) -> bool:
        return self._iso is not None

    @classmethod
    def fit(cls, raw_probs: np.ndarray, actuals: np.ndarray) -> "ProbabilityCalibrator":
        iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
        iso.fit(np.asarray(raw_probs, dtype=float), np.asarray(actuals, dtype=float))
        return cls(iso)

    def transform_one(self, prob: float) -> float:
        if self._iso is None:
            return float(prob)
        return float(self._iso.predict([prob])[0])

    def transform(self, probs: np.ndarray) -> np.ndarray:
        if self._iso is None:
            return np.asarray(probs, dtype=float)
        return self._iso.predict(np.asarray(probs, dtype=float))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as fh:
            pickle.dump(self._iso, fh)

    @classmethod
    def load(cls, path: Path) -> "ProbabilityCalibrator":
        if not path.exists():
            return cls(None)
        with path.open("rb") as fh:
            return cls(pickle.load(fh))
