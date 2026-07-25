"""Unit tests for the prediction engine's stages.

Covers the deterministic logic (features, baseline, ensemble, calibration, error
analysis, self-learning) plus a real train→predict roundtrip and a full
fixture-backed pipeline run.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from sportslab_engine.calibration.calibrator import ProbabilityCalibrator
from sportslab_engine.config import EngineConfig
from sportslab_engine.contracts import FEATURE_ORDER
from sportslab_engine.error_analysis.analyze import analyze
from sportslab_engine.ensemble.manager import DEFAULT_WEIGHTS, combine
from sportslab_engine.contracts import RawModelOutput
from sportslab_engine.features.builder import build_features, wind_signed
from sportslab_engine.models import baseline
from sportslab_engine.models.gbm import XgbGameModel
from sportslab_engine.pipeline import implied_prob, run_pipeline
from sportslab_engine.self_learning.learn import learn
from sportslab_engine.training.train import train


FIXTURES = Path(__file__).resolve().parents[1] / "src" / "sportslab_engine" / "ingest" / "fixtures"


def _slate_game() -> dict:
    slate = json.loads((FIXTURES / "slate_2026-07-25.json").read_text())
    return slate["games"][0]


def test_wind_signed():
    assert wind_signed({"windDir": "out", "windMph": 12}) == 12
    assert wind_signed({"windDir": "in", "windMph": 10}) == -10
    assert wind_signed({"windDir": "calm", "windMph": 5}) == 0
    assert wind_signed(None) == 0


def test_build_features_has_full_ordered_vector():
    row = build_features(_slate_game())
    assert list(row.keys()) == list(FEATURE_ORDER)
    assert row["home_starter_era"] == 2.9
    assert row["wind_signed"] == 12  # 12mph blowing out


def test_baseline_favors_the_better_matchup():
    row = build_features(_slate_game())  # HOU strong starter, wind out
    out = baseline.predict(row)
    assert 0.5 < out.home_win_prob < 1.0
    assert out.predicted_total > 0


def test_ensemble_agreement_and_weighting():
    members = [
        RawModelOutput("baseline", 0.60, 8.5),
        RawModelOutput("xgboost", 0.62, 8.9),
    ]
    res = combine(members, DEFAULT_WEIGHTS)
    # Weighted toward xgboost (0.6) but between the two members.
    assert 0.60 <= res.home_win_prob <= 0.62
    assert res.component_agreement > 0.9  # they nearly agree


def test_ensemble_low_agreement_when_members_diverge():
    members = [
        RawModelOutput("baseline", 0.40, 8.0),
        RawModelOutput("xgboost", 0.75, 9.0),
    ]
    res = combine(members, DEFAULT_WEIGHTS)
    assert res.component_agreement < 0.5


def test_calibrator_identity_when_unfitted():
    cal = ProbabilityCalibrator(None)
    assert cal.transform_one(0.73) == 0.73
    assert not cal.fitted


def test_calibrator_learns_monotonic_mapping():
    rng = np.random.default_rng(0)
    raw = rng.random(500)
    # True prob is raw**2 — miscalibrated input.
    actual = (rng.random(500) < raw**2).astype(int)
    cal = ProbabilityCalibrator.fit(raw, actual)
    assert cal.fitted
    # Calibrated high input should exceed calibrated low input (monotonic).
    assert cal.transform_one(0.9) >= cal.transform_one(0.2)


def test_implied_prob_from_american_odds():
    assert implied_prob(-150) == pytest.approx(0.6, abs=1e-9)
    assert implied_prob(150) == pytest.approx(0.4, abs=1e-9)


def test_xgb_train_predict_roundtrip(tmp_path):
    rng = np.random.default_rng(1)
    n = 400
    X = rng.normal(0, 1, (n, len(FEATURE_ORDER)))
    # Signal: home wins when feature 0 (home_starter_era, lower is better) is low.
    y_win = (X[:, 0] < 0).astype(int)
    y_total = 8 + X[:, 6]  # tied to a batting feature
    model = XgbGameModel.train(X, y_win, y_total, n_estimators=60)
    model.save(tmp_path / "xgb")
    loaded = XgbGameModel.load(tmp_path / "xgb")
    feats = {k: 0.0 for k in FEATURE_ORDER}
    feats["home_starter_era"] = -2.0  # strongly "home should win"
    out = loaded.predict(feats)
    assert out.home_win_prob > 0.5
    assert out.name == "xgboost"


def test_full_pipeline_on_fixtures(tmp_path):
    cfg = EngineConfig(artifacts_dir=tmp_path / "artifacts", output_dir=tmp_path / "out")
    train(config=cfg)  # trains on the historical fixture
    preds = run_pipeline("2026-07-25", cfg)
    assert len(preds) == 3
    for p in preds:
        j = p.to_review_json()
        ml = j["model"]["moneyline"]
        assert abs(ml["homeWinProb"] + ml["awayWinProb"] - 1.0) < 1e-6
        assert j["confidence"] in {"S", "A", "B", "C"}
        assert 0.0 <= j["model"]["componentAgreement"] <= 1.0


def test_error_analysis_metrics():
    settled = {
        "date": "2026-07-25",
        "settled": [
            {
                "gameId": "g1",
                "homeWinProb": 0.7,
                "moneylinePick": "home",
                "moneylineCorrect": True,
                "finalConfidence": "A",
                "totalPick": "over",
                "totalCorrect": True,
                "actualHomeWin": True,
                "evBets": [{"selection": "H ML", "positive": True, "profit": 0.8}],
            },
            {
                "gameId": "g2",
                "homeWinProb": 0.55,
                "moneylinePick": "home",
                "moneylineCorrect": False,
                "finalConfidence": "C",
                "totalPick": "under",
                "totalCorrect": False,
                "actualHomeWin": False,
                "evBets": [{"selection": "H ML", "positive": True, "profit": -1.0}],
            },
        ],
    }
    report = analyze(settled)
    assert report["n"] == 2
    assert report["moneyline"]["accuracy"] == 0.5
    assert report["ev"]["positiveBets"] == 2
    assert report["ev"]["unitsReturned"] == pytest.approx(-0.2, abs=1e-6)
    assert "ece" in report["calibration"]


def test_self_learning_shifts_weights_on_overconfidence(tmp_path):
    art = tmp_path / "artifacts"
    art.mkdir()
    # Strongly over-confident report → weight should move off the GBM.
    report = {"overconfidenceSignal": 0.15, "calibration": {"ece": 0.08}}
    result = learn(report, art)
    assert result["newWeights"]["xgboost"] < DEFAULT_WEIGHTS["xgboost"]
    assert result["recalibrate"] is True
    # Persisted for the next run.
    saved = json.loads((art / "ensemble_weights.json").read_text())
    assert saved["xgboost"] == result["newWeights"]["xgboost"]


def test_self_learning_deadband_leaves_weights(tmp_path):
    art = tmp_path / "artifacts"
    art.mkdir()
    report = {"overconfidenceSignal": 0.005, "calibration": {"ece": 0.02}}
    result = learn(report, art)
    assert result["newWeights"]["xgboost"] == pytest.approx(DEFAULT_WEIGHTS["xgboost"])
    assert result["recalibrate"] is False
