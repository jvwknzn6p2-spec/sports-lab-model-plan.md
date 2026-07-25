"""Prediction Engine (Component 1) — load models and produce raw opinions.

Given a feature row, it runs every available model member (XGBoost if trained,
always the transparent baseline, LightGBM if present) and returns their raw
outputs for the Ensemble Manager to combine. Keeping "run the models" separate
from "combine the models" is what lets the ensemble and calibration evolve
independently of the models themselves.
"""

from __future__ import annotations

from ..config import DEFAULT_CONFIG, EngineConfig
from ..contracts import RawModelOutput
from ..models import baseline
from ..models.gbm import XgbGameModel, artifacts_exist
from ..training.train import MODEL_DIR


class PredictionEngine:
    def __init__(self, config: EngineConfig = DEFAULT_CONFIG):
        self.config = config
        self._xgb: XgbGameModel | None = None
        model_dir = config.artifact(MODEL_DIR)
        if artifacts_exist(model_dir):
            self._xgb = XgbGameModel.load(model_dir)

    @property
    def has_gbm(self) -> bool:
        return self._xgb is not None

    def predict_members(self, features: dict[str, float]) -> list[RawModelOutput]:
        members: list[RawModelOutput] = [baseline.predict(features)]
        if self._xgb is not None:
            members.append(self._xgb.predict(features))
        return members
