"""Feature extraction + XGBoost production adapter tests.

The adapter is tested with lightweight stub runs-models so no xgboost/numpy
install is required for the core contract; a separate test exercises the real
xgboost path only when it is available."""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.enums import ModelType
from app.domain.prediction.features import FEATURE_NAMES, extract_features
from app.infrastructure.model_adapters.xgboost_adapter import XGBoostModelAdapter
from app.schemas.control_tower import ControlTowerPayload


class _StubRunsModel:
    def __init__(self, value: float) -> None:
        self._value = value

    def predict_runs(self, features: list[float]) -> float:
        # Deterministic, mildly feature-dependent so identical inputs match.
        return self._value + 0.001 * sum(features[:2])


def _adapter(home=4.8, away=4.0) -> XGBoostModelAdapter:
    return XGBoostModelAdapter(
        _StubRunsModel(home),
        _StubRunsModel(away),
        model_id="xgb-test",
        model_version="0.0.1",
        feature_version="features-1.0.0",
        medians={name: 1.0 for name in FEATURE_NAMES},
        max_runs=18,
    )


def test_feature_extraction_reports_missing_and_uses_medians(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    medians = {name: 2.0 for name in FEATURE_NAMES}
    extracted = extract_features(payload.games[0], medians)
    assert len(extracted.values) == len(FEATURE_NAMES)
    # The example provides bullpen + market features but not starter ERA etc.,
    # so some features are missing and flagged (never silently imputed).
    assert extracted.missing
    assert all("missing feature" in w for w in extracted.warnings)
    assert 0.0 <= extracted.completeness <= 1.0


def test_feature_extraction_prefers_engineered_values(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    game = payload.games[0]
    # Inject engineered features onto feature_summary (extra fields allowed).
    game.feature_summary.__pydantic_extra__["home_starter_era"] = 2.5
    extracted = extract_features(game, {name: 9.0 for name in FEATURE_NAMES})
    idx = FEATURE_NAMES.index("home_starter_era")
    assert extracted.values[idx] == 2.5


def test_adapter_produces_valid_prediction(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    adapter = _adapter()
    assert adapter.info().model_type is ModelType.XGBOOST
    assert adapter.info().is_production is True

    raw = adapter.predict_game(payload.games[0], payload)
    assert raw.fallback_used is False
    total = raw.raw_home_win_probability + raw.raw_away_win_probability
    assert abs(total - Decimal("1")) < Decimal("0.0001")
    assert raw.raw_margin_distribution is not None
    dist_total = sum(raw.raw_margin_distribution.values())
    assert abs(dist_total - Decimal("1")) < Decimal("0.01")
    assert raw.raw_team_score_expectations["home"] > 0


def test_adapter_is_deterministic(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    adapter = _adapter()
    a = adapter.predict_game(payload.games[0], payload)
    b = adapter.predict_game(payload.games[0], payload)
    assert a.raw_home_win_probability == b.raw_home_win_probability
    assert a.raw_margin_distribution == b.raw_margin_distribution


def test_higher_home_runs_favor_home(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    strong_home = _adapter(home=6.5, away=3.2).predict_game(payload.games[0], payload)
    assert strong_home.raw_home_win_probability > Decimal("0.5")


xgb = pytest.importorskip("xgboost")  # noqa: F841 — gate the real-model test


def test_real_xgboost_roundtrip(tmp_path, valid_payload):
    """Train tiny boosters, save an artifact, load via the adapter, predict."""

    import numpy as np
    import xgboost as xgboost_lib

    rng = np.random.default_rng(0)
    x = rng.normal(0.0, 1.0, (200, len(FEATURE_NAMES))).astype("float32")
    y_home = rng.poisson(4.5, 200).astype("float32")
    y_away = rng.poisson(4.0, 200).astype("float32")

    def train(y):
        dtrain = xgboost_lib.DMatrix(x, label=y)
        return xgboost_lib.train(
            {"objective": "count:poisson", "max_depth": 3, "seed": 0},
            dtrain,
            num_boost_round=10,
        )

    import json

    train(y_home).save_model(str(tmp_path / "home_runs.ubj"))
    train(y_away).save_model(str(tmp_path / "away_runs.ubj"))
    (tmp_path / "metadata.json").write_text(
        json.dumps(
            {
                "model_id": "xgb-rt",
                "model_version": "0.0.1",
                "feature_version": "features-1.0.0",
                "feature_names": list(FEATURE_NAMES),
                "medians": {name: 0.0 for name in FEATURE_NAMES},
                "max_runs": 18,
            }
        )
    )

    adapter = XGBoostModelAdapter.from_artifact(tmp_path)
    payload = ControlTowerPayload.model_validate(valid_payload)
    raw = adapter.predict_game(payload.games[0], payload)
    assert raw.fallback_used is False
    total = raw.raw_home_win_probability + raw.raw_away_win_probability
    assert abs(total - Decimal("1")) < Decimal("0.0001")
