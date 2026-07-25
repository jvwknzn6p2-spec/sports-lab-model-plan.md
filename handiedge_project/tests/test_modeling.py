"""Baseline model + calibration + abstention tests (audit category 6)."""

from __future__ import annotations

import numpy as np

from handiedge.modeling.abstention import AbstainReason, AbstentionPolicy
from handiedge.modeling.baselines import AlwaysBaseProb, LogisticRegression, MarketImpliedBaseline
from handiedge.modeling.calibration import IsotonicCalibrator, PlattCalibrator
from handiedge.modeling.seeding import rng, set_global_seed


def test_deterministic_seed():
    set_global_seed(123)
    a = np.random.rand(3)
    set_global_seed(123)
    b = np.random.rand(3)
    assert np.allclose(a, b)
    assert np.allclose(rng(7).random(3), rng(7).random(3))


def test_logistic_learns_separable():
    r = rng(0)
    X = r.normal(size=(400, 2))
    y = (X[:, 0] + 0.5 * X[:, 1] > 0).astype(float)
    model = LogisticRegression(n_iter=1500).fit(X, y)
    p = model.predict_proba(X)
    acc = ((p > 0.5) == y).mean()
    assert acc > 0.9


def test_market_baseline_returns_fair_col():
    X = np.array([[0.6, 1.0], [0.3, 2.0]])
    assert np.allclose(MarketImpliedBaseline(fair_prob_col=0).predict_proba(X), [0.6, 0.3])
    assert np.allclose(AlwaysBaseProb(0.5).predict_proba(X), [0.5, 0.5])


def test_isotonic_is_monotone_and_improves_calibration():
    r = rng(1)
    raw = r.uniform(0, 1, 500)
    # True prob is a squashed version -> raw is miscalibrated.
    true_p = raw**2
    y = (r.uniform(0, 1, 500) < true_p).astype(float)
    cal = IsotonicCalibrator().fit(raw, y)
    out = cal.transform(np.sort(raw))
    assert np.all(np.diff(out) >= -1e-9)  # monotone non-decreasing

    from handiedge.evaluation.metrics import brier_score

    assert brier_score(y, cal.transform(raw)) <= brier_score(y, raw) + 1e-6


def test_platt_calibrator_runs():
    r = rng(2)
    raw = r.uniform(0, 1, 200)
    y = (raw > 0.5).astype(float)
    cal = PlattCalibrator(n_iter=500).fit(raw, y)
    out = cal.transform(raw)
    assert out.shape == raw.shape
    assert np.all((out > 0) & (out < 1))


def test_abstention_reasons():
    pol = AbstentionPolicy(min_edge=0.02, min_confidence=0.55, min_history_lines=1)
    assert pol.evaluate(prob_a=0.9, edge=0.1, n_lines_seen=0, n_core4_picks=0) is (
        AbstainReason.INSUFFICIENT_HISTORY
    )
    assert pol.evaluate(prob_a=0.51, edge=0.1, n_lines_seen=3, n_core4_picks=1) is (
        AbstainReason.LOW_CONFIDENCE
    )
    assert pol.evaluate(prob_a=0.9, edge=0.001, n_lines_seen=3, n_core4_picks=1) is (
        AbstainReason.INSUFFICIENT_EDGE
    )
    assert pol.evaluate(prob_a=0.9, edge=0.1, n_lines_seen=3, n_core4_picks=1) is None
