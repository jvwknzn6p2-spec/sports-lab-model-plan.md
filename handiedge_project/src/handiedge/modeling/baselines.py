"""Baseline models (audit category 6).

At least one naive baseline must be reported alongside any trained model so that
lift over baseline is visible. Implemented in pure NumPy to keep the domain core
free of heavy ML dependencies (LightGBM/Optuna live behind a port — see
``ports/external.py`` — and are not required to run the core or its tests).

Models expose a common ``predict_proba(X) -> p(side A covers)`` contract.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class Model:
    def predict_proba(self, X: np.ndarray) -> np.ndarray:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class MarketImpliedBaseline(Model):
    """Predicts the market's own (vig-removed) fair probability for side A.

    The single most important baseline: a model must beat the market's own price
    to be useful. ``X`` here is expected to already contain the fair prob column.
    """

    fair_prob_col: int = 0

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        p = np.clip(X[:, self.fair_prob_col], 1e-6, 1 - 1e-6)
        return p


@dataclass
class AlwaysBaseProb(Model):
    """Constant-probability baseline (e.g. always 0.5)."""

    p: float = 0.5

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return np.full(X.shape[0], np.clip(self.p, 1e-6, 1 - 1e-6))


class LogisticRegression(Model):
    """Minimal L2-regularised logistic regression via gradient descent.

    Deterministic given a seed and fixed iterations; a transparent, dependency-free
    trained baseline. Not a substitute for the gradient-boosted model that would
    live behind the ML port, but fully runnable and testable here.
    """

    def __init__(self, lr: float = 0.1, n_iter: int = 2000, l2: float = 1e-3) -> None:
        self.lr = lr
        self.n_iter = n_iter
        self.l2 = l2
        self.w: np.ndarray | None = None
        self.b: float = 0.0
        self._mu: np.ndarray | None = None
        self._sd: np.ndarray | None = None

    @staticmethod
    def _sigmoid(z: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))

    def fit(self, X: np.ndarray, y: np.ndarray) -> LogisticRegression:
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        self._mu = X.mean(axis=0)
        self._sd = X.std(axis=0)
        self._sd[self._sd == 0] = 1.0
        Xs = (X - self._mu) / self._sd
        n, d = Xs.shape
        self.w = np.zeros(d)
        self.b = 0.0
        for _ in range(self.n_iter):
            p = self._sigmoid(Xs @ self.w + self.b)
            grad_w = Xs.T @ (p - y) / n + self.l2 * self.w
            grad_b = float(np.mean(p - y))
            self.w -= self.lr * grad_w
            self.b -= self.lr * grad_b
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.w is None or self._mu is None or self._sd is None:
            raise RuntimeError("model is not fitted")
        Xs = (np.asarray(X, dtype=float) - self._mu) / self._sd
        return np.clip(self._sigmoid(Xs @ self.w + self.b), 1e-6, 1 - 1e-6)
