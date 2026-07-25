"""Active model introspection.

Exposes which prediction adapter is live so operators can verify at a glance
whether the production model (``is_production=true``) or the NON-PRODUCTION
fallback is currently serving predictions.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_prediction_adapter, get_settings_dep
from app.core.config import Settings
from app.domain.prediction.adapter import PredictionAdapter

router = APIRouter(prefix="/api/v1", tags=["model"])


@router.get("/model")
def active_model(
    adapter: PredictionAdapter = Depends(get_prediction_adapter),
    settings: Settings = Depends(get_settings_dep),
) -> dict:
    info = adapter.info()
    return {
        "model_adapter": settings.model_adapter,
        "model_id": info.model_id,
        "model_version": info.model_version,
        "model_type": info.model_type.value,
        "is_production": info.is_production,
        "fallback": not info.is_production,
        "calibration_configured": settings.calibration_artifact_path is not None,
        "calibration_version": settings.calibration_version,
    }
