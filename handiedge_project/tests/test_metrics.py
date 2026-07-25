"""Evaluation metric tests (audit category 7)."""

from __future__ import annotations

import numpy as np

from handiedge.evaluation.metrics import (
    bonferroni,
    brier_score,
    clv,
    diebold_mariano,
    expected_calibration_error,
    hit_rate_with_ci,
    log_loss,
    max_drawdown,
    roi_with_ci,
)


def test_log_loss_perfect_vs_wrong():
    y = np.array([1, 0, 1, 0])
    good = np.array([0.99, 0.01, 0.99, 0.01])
    bad = np.array([0.01, 0.99, 0.01, 0.99])
    assert log_loss(y, good) < log_loss(y, bad)


def test_brier_bounds():
    y = np.array([1, 0])
    assert 0.0 <= brier_score(y, np.array([0.5, 0.5])) <= 1.0


def test_ece_zero_for_calibrated():
    # 100 predictions at p=0.7 with exactly 70% positives -> near-zero ECE.
    y = np.array([1] * 70 + [0] * 30)
    p = np.full(100, 0.7)
    rep = expected_calibration_error(y, p, n_bins=10)
    assert rep.ece < 0.02
    assert sum(b[2] for b in rep.bins) == 100


def test_hit_rate_ci_contains_point():
    y = np.array([1, 1, 0, 1, 0, 1, 1, 0, 1, 1])
    pick = np.ones(10, dtype=int)
    hr = hit_rate_with_ci(y, pick)
    assert hr.ci_lower <= hr.hit_rate <= hr.ci_upper
    assert hr.n == 10


def test_roi_ci_reports_n_and_interval():
    stakes = np.ones(50)
    net = np.array([0.9, -1.0] * 25)
    res = roi_with_ci(stakes, net, n_boot=500)
    assert res.n_bets == 50
    assert res.ci_lower <= res.roi <= res.ci_upper


def test_clv_positive_when_entry_better_than_close():
    # entry fair prob higher than closing on picked side => positive CLV.
    assert clv(np.array([0.55, 0.60]), np.array([0.50, 0.55])) > 0


def test_max_drawdown():
    equity = np.array([100, 120, 90, 110, 60])
    # peak 120 -> trough 60 = 0.5 drawdown.
    assert abs(max_drawdown(equity) - 0.5) < 1e-9


def test_diebold_mariano_and_bonferroni():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 1, 200)
    b = a + 0.5  # b consistently worse
    dm, p = diebold_mariano(a, b)
    assert dm < 0
    flags = bonferroni([0.001, 0.5, 0.02], alpha=0.05)
    assert flags == [True, False, False]
