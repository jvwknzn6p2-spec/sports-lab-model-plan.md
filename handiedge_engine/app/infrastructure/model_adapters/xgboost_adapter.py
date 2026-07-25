"""Production XGBoost prediction adapter.

Implements the ``ProductionModelAdapter`` contract with two trained XGBoost
regressors that predict each team's expected runs. The joint margin distribution
(and a self-consistent moneyline) then follow from an independent-Poisson score
model. This keeps the normal-win prediction and the handicap cover probability
derived from the SAME distribution, rather than copying one into the other.

xgboost/numpy are imported lazily so the rest of the engine runs without them;
this adapter is only constructed when explicitly configured.

Artifact bundle layout (``model_artifact_dir``):
    metadata.json     model_id, model_version, feature_version, feature_names,
                      medians, max_runs
    home_runs.ubj     XGBoost booster predicting home expected runs
    away_runs.ubj     XGBoost booster predicting away expected runs
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol, runtime_checkable

from app.core.enums import ModelType
from app.core.exceptions import ConfigurationError
from app.domain.prediction.adapter import AdapterInfo
from app.domain.prediction.features import FEATURE_NAMES, extract_features
from app.domain.prediction.poisson import margin_distribution, moneyline_from_margin
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.prediction import RawGamePrediction

# Clamp expected runs to a sane baseball range so a mis-scaled feature can never
# produce a degenerate distribution.
_MIN_RUNS = 0.5
_MAX_RUNS_MEAN = 15.0


@runtime_checkable
class RunsModel(Protocol):
    """Predicts an expected-runs value from an ordered feature vector."""

    def predict_runs(self, features: list[float]) -> float: ...


class XGBoostRunsModel:
    """Wraps a trained ``xgboost.Booster`` loaded from a ``.ubj`` artifact."""

    def __init__(self, booster) -> None:  # booster: xgboost.Booster
        self._booster = booster

    @classmethod
    def load(cls, path: Path) -> XGBoostRunsModel:
        try:
            import xgboost as xgb
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise ConfigurationError(
                "xgboost is required for the XGBoost adapter but is not installed"
            ) from exc
        if not path.exists():
            raise ConfigurationError(f"model artifact not found: {path}")
        booster = xgb.Booster()
        booster.load_model(str(path))
        return cls(booster)

    def predict_runs(self, features: list[float]) -> float:
        import numpy as np
        import xgboost as xgb

        matrix = xgb.DMatrix(np.asarray([features], dtype="float32"))
        value = float(self._booster.predict(matrix)[0])
        return value


class XGBoostModelAdapter:
    """Production adapter: two runs regressors + independent-Poisson margin."""

    def __init__(
        self,
        home_model: RunsModel,
        away_model: RunsModel,
        *,
        model_id: str,
        model_version: str,
        feature_version: str,
        medians: dict[str, float],
        max_runs: int = 20,
    ) -> None:
        self._home_model = home_model
        self._away_model = away_model
        self._model_id = model_id
        self._model_version = model_version
        self._feature_version = feature_version
        self._medians = medians
        self._max_runs = max_runs

    # -- ProductionModelAdapter -------------------------------------------- #

    def info(self) -> AdapterInfo:
        return AdapterInfo(
            model_id=self._model_id,
            model_version=self._model_version,
            model_type=ModelType.XGBOOST,
            is_production=True,
        )

    def load_artifact(self, artifact_uri: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError("use XGBoostModelAdapter.from_artifact(dir) instead")

    def predict_game(
        self, game: ControlTowerGame, payload: ControlTowerPayload
    ) -> RawGamePrediction:
        extracted = extract_features(game, self._medians)
        features = list(extracted.values)

        mu_home = _clamp(self._home_model.predict_runs(features))
        mu_away = _clamp(self._away_model.predict_runs(features))

        dist = margin_distribution(mu_home, mu_away, max_runs=self._max_runs)
        home_p, away_p = moneyline_from_margin(dist)

        warnings: list[str] = list(extracted.warnings)
        warnings.append(
            f"xgboost expected_runs home={mu_home:.3f} away={mu_away:.3f}"
        )
        if extracted.completeness < 1.0:
            warnings.append(f"feature_completeness={extracted.completeness:.3f}")

        from decimal import Decimal

        return RawGamePrediction(
            match_id=game.match_id,
            raw_home_win_probability=home_p,
            raw_away_win_probability=away_p,
            raw_team_score_expectations={
                "home": Decimal(str(round(mu_home, 2))),
                "away": Decimal(str(round(mu_away, 2))),
            },
            raw_margin_distribution=dist,
            feature_snapshot_id=game.feature_summary.feature_snapshot_id,
            inference_warnings=tuple(warnings),
            fallback_used=False,
        )

    # -- construction ------------------------------------------------------ #

    @classmethod
    def from_artifact(cls, artifact_dir: str | Path) -> XGBoostModelAdapter:
        directory = Path(artifact_dir)
        meta_path = directory / "metadata.json"
        if not meta_path.exists():
            raise ConfigurationError(f"artifact metadata not found: {meta_path}")
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

        feature_names = tuple(meta.get("feature_names", FEATURE_NAMES))
        if feature_names != FEATURE_NAMES:
            raise ConfigurationError(
                "artifact feature_names do not match the current feature contract; "
                "retrain against the current FEATURE_NAMES or bump the feature version"
            )

        home_model = XGBoostRunsModel.load(directory / "home_runs.ubj")
        away_model = XGBoostRunsModel.load(directory / "away_runs.ubj")
        return cls(
            home_model,
            away_model,
            model_id=meta["model_id"],
            model_version=meta["model_version"],
            feature_version=meta.get("feature_version", "features-1.0.0"),
            medians={k: float(v) for k, v in meta.get("medians", {}).items()},
            max_runs=int(meta.get("max_runs", 20)),
        )


def _clamp(value: float) -> float:
    if value < _MIN_RUNS:
        return _MIN_RUNS
    if value > _MAX_RUNS_MEAN:
        return _MAX_RUNS_MEAN
    return value
