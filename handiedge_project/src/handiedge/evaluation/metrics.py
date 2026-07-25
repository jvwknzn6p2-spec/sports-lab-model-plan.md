"""Evaluation metrics (audit category 7).

Probability-quality metrics (log loss, Brier, ECE) and profitability metrics (ROI
with CI, CLV, max drawdown) are computed by *separate* functions and must be
reported together — never substitute one axis for the other (skill hard rule).
Every profitability metric reports its sample size; small-n results are flagged
by the caller. Formulas follow ``references/metrics-formulas.md``.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats

_EPS = 1e-15


def _clip(p: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(p, dtype=float), _EPS, 1 - _EPS)


def log_loss(y_true: np.ndarray, p: np.ndarray) -> float:
    y = np.asarray(y_true, dtype=float)
    pc = _clip(p)
    return float(-np.mean(y * np.log(pc) + (1 - y) * np.log(1 - pc)))


def brier_score(y_true: np.ndarray, p: np.ndarray) -> float:
    y = np.asarray(y_true, dtype=float)
    return float(np.mean((np.asarray(p, dtype=float) - y) ** 2))


@dataclass(frozen=True, slots=True)
class CalibrationReport:
    ece: float
    bins: tuple[tuple[float, float, int], ...]  # (mean_pred, obs_freq, n) per bin


def expected_calibration_error(
    y_true: np.ndarray, p: np.ndarray, n_bins: int = 10
) -> CalibrationReport:
    y = np.asarray(y_true, dtype=float)
    pr = np.asarray(p, dtype=float)
    n = len(pr)
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    rows: list[tuple[float, float, int]] = []
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (pr >= lo) & (pr < hi) if i < n_bins - 1 else (pr >= lo) & (pr <= hi)
        nk = int(mask.sum())
        if nk == 0:
            rows.append((float((lo + hi) / 2), 0.0, 0))
            continue
        mean_pred = float(pr[mask].mean())
        obs = float(y[mask].mean())
        ece += (nk / n) * abs(mean_pred - obs)
        rows.append((mean_pred, obs, nk))
    return CalibrationReport(ece=float(ece), bins=tuple(rows))


@dataclass(frozen=True, slots=True)
class HitRate:
    hit_rate: float
    ci_lower: float
    ci_upper: float
    n: int


def hit_rate_with_ci(y_true: np.ndarray, pick: np.ndarray, alpha: float = 0.05) -> HitRate:
    """Hit rate with Wilson score interval."""
    y = np.asarray(y_true)
    pk = np.asarray(pick)
    n = int(len(y))
    if n == 0:
        return HitRate(0.0, 0.0, 0.0, 0)
    hits = int((y == pk).sum())
    phat = hits / n
    z = float(stats.norm.ppf(1 - alpha / 2))
    denom = 1 + z**2 / n
    centre = (phat + z**2 / (2 * n)) / denom
    half = (z * np.sqrt(phat * (1 - phat) / n + z**2 / (4 * n**2))) / denom
    return HitRate(phat, max(0.0, centre - half), min(1.0, centre + half), n)


@dataclass(frozen=True, slots=True)
class ROIResult:
    roi: float
    ci_lower: float
    ci_upper: float
    n_bets: int
    total_staked: float


def roi_with_ci(
    stakes: np.ndarray,
    net_returns: np.ndarray,
    *,
    n_boot: int = 2000,
    alpha: float = 0.05,
    seed: int = 20260723,
) -> ROIResult:
    """ROI = sum(net)/sum(stake), with a bootstrap CI over bets.

    ``net_returns[i]`` is profit/loss for bet i (negative = loss). Never returned
    as a bare point estimate.
    """
    s = np.asarray(stakes, dtype=float)
    r = np.asarray(net_returns, dtype=float)
    n = len(s)
    if n == 0 or s.sum() == 0:
        return ROIResult(0.0, 0.0, 0.0, 0, 0.0)
    roi = float(r.sum() / s.sum())
    rng = np.random.default_rng(seed)
    boots = np.empty(n_boot)
    idx = np.arange(n)
    for b in range(n_boot):
        pick = rng.choice(idx, size=n, replace=True)
        ss = s[pick].sum()
        boots[b] = r[pick].sum() / ss if ss > 0 else 0.0
    lo, hi = np.quantile(boots, [alpha / 2, 1 - alpha / 2])
    return ROIResult(roi, float(lo), float(hi), n, float(s.sum()))


def clv(
    entry_fair_prob: np.ndarray,
    closing_fair_prob: np.ndarray,
) -> float:
    """Closing Line Value on the *picked side*, using vig-removed fair probs.

    CLV = mean(p_entry / p_close - 1). Positive => bets placed at better-than-
    closing value. Inputs must already be fair probabilities for the same picked
    side on both ends.
    """
    entry = np.asarray(entry_fair_prob, dtype=float)
    close = np.clip(np.asarray(closing_fair_prob, dtype=float), _EPS, None)
    return float(np.mean(entry / close - 1.0))


def max_drawdown(equity: np.ndarray) -> float:
    """Maximum fractional drawdown of a bankroll/equity path."""
    eq = np.asarray(equity, dtype=float)
    if len(eq) == 0:
        return 0.0
    running_max = np.maximum.accumulate(eq)
    running_max = np.where(running_max == 0, _EPS, running_max)
    dd = (running_max - eq) / running_max
    return float(np.max(dd))


def diebold_mariano(errors_a: np.ndarray, errors_b: np.ndarray) -> tuple[float, float]:
    """DM test on two models' error series. Returns (statistic, two-sided p)."""
    d = np.asarray(errors_a, dtype=float) - np.asarray(errors_b, dtype=float)
    n = len(d)
    sd = d.std(ddof=1)
    if sd == 0:
        return 0.0, 1.0
    dm = float(d.mean() / (sd / np.sqrt(n)))
    p = float(2 * (1 - stats.norm.cdf(abs(dm))))
    return dm, p


def bonferroni(p_values: list[float], alpha: float = 0.05) -> list[bool]:
    """Bonferroni multiple-comparison correction. True => significant."""
    k = len(p_values)
    threshold = alpha / k if k > 0 else alpha
    return [p < threshold for p in p_values]
