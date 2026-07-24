"""Prediction adapter protocol and shared context types.

Every concrete model (XGBoost, LightGBM, Elo, ensemble, ...) implements
``PredictionAdapter``. Model-specific logic is fully isolated behind this
interface; the rest of the pipeline only sees :class:`RawGamePrediction`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from app.core.enums import ModelType
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.prediction import RawGamePrediction


@dataclass(frozen=True)
class AdapterInfo:
    model_id: str
    model_version: str
    model_type: ModelType
    is_production: bool


@runtime_checkable
class PredictionAdapter(Protocol):
    """Interface every prediction model must implement."""

    def info(self) -> AdapterInfo: ...

    def predict_game(
        self, game: ControlTowerGame, payload: ControlTowerPayload
    ) -> RawGamePrediction: ...


class ProductionModelAdapter(PredictionAdapter, Protocol):
    """Marker protocol for trained, validated production adapters.

    Concrete production adapters (e.g. an XGBoost booster loaded from the model
    registry) implement this. See the README integration guide.
    """

    def load_artifact(self, artifact_uri: str) -> None: ...
