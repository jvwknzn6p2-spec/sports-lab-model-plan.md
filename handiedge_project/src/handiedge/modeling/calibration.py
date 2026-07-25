"""Probability calibration (audit category 6).

Two calibrators, both fit on a holdout disjoint from point-estimate training:
- Isotonic regression via Pool-Adjacent-Violators (monotone, non-parametric);
- Platt scaling (logistic on the raw score).

Fitting on the same data used to train the base model would leak — callers must
pass a holdout. This is a discipline the API enforces via the split utilities.
"""

from __future__ import annotations

import numpy as np


class IsotonicCalibrator:
    """Monotone isotonic regression (PAVA). Maps raw prob -> calibrated prob."""

    def __init__(self) -> None:
        self._x: np.ndarray | None = None
        self._y: np.ndarray | None = None

    def fit(self, raw: np.ndarray, y: np.ndarray) -> IsotonicCalibrator:
        raw = np.asarray(raw, dtype=float)
        y = np.asarray(y, dtype=float)
        order = np.argsort(raw, kind="mergesort")
        x = raw[order]
        target = y[order]
        # PAVA on weighted means.
        w = np.ones_like(target)
        vals = target.copy()
        i = 0
        # Merge adjacent violators.
        blocks: list[list[float]] = [[vals[0], w[0], x[0]]]
        for k in range(1, len(vals)):
            blocks.append([vals[k], w[k], x[k]])
            while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
                v2, w2, x2 = blocks.pop()
                v1, w1, x1 = blocks.pop()
                merged_v = (v1 * w1 + v2 * w2) / (w1 + w2)
                blocks.append([merged_v, w1 + w2, x1])
            i += 1
        self._x = np.array([b[2] for b in blocks])
        self._y = np.clip(np.array([b[0] for b in blocks]), 1e-6, 1 - 1e-6)
        return self

    def transform(self, raw: np.ndarray) -> np.ndarray:
        if self._x is None or self._y is None:
            raise RuntimeError("calibrator not fitted")
        raw = np.asarray(raw, dtype=float)
        return np.interp(raw, self._x, self._y, left=self._y[0], right=self._y[-1])


class PlattCalibrator:
    """Platt scaling: sigmoid(a*score + b) fit by gradient descent on a holdout."""

    def __init__(self, lr: float = 0.5, n_iter: int = 2000) -> None:
        self.a = 1.0
        self.b = 0.0
        self.lr = lr
        self.n_iter = n_iter

    @staticmethod
    def _sigmoid(z: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))

    def fit(self, raw: np.ndarray, y: np.ndarray) -> PlattCalibrator:
        s = np.asarray(raw, dtype=float)
        y = np.asarray(y, dtype=float)
        for _ in range(self.n_iter):
            p = self._sigmoid(self.a * s + self.b)
            ga = float(np.mean((p - y) * s))
            gb = float(np.mean(p - y))
            self.a -= self.lr * ga
            self.b -= self.lr * gb
        return self

    def transform(self, raw: np.ndarray) -> np.ndarray:
        s = np.asarray(raw, dtype=float)
        return np.clip(self._sigmoid(self.a * s + self.b), 1e-6, 1 - 1e-6)
