"""Prediction run endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import (
    get_correlation_id,
    get_db,
    get_prediction_adapter,
    get_settings_dep,
    require_api_key,
)
from app.core.config import Settings
from app.core.exceptions import NotFoundError
from app.domain.prediction.adapter import PredictionAdapter
from app.repositories.prediction_repository import PredictionRepository
from app.schemas.prediction import PredictionRunResponse
from app.services.orchestration_service import OrchestrationService

router = APIRouter(prefix="/api/v1/predictions", tags=["predictions"])


@router.post("/run", response_model=PredictionRunResponse, dependencies=[Depends(require_api_key)])
def run_prediction(
    payload: dict[str, Any],
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    adapter: PredictionAdapter = Depends(get_prediction_adapter),
    correlation_id: str = Depends(get_correlation_id),
) -> PredictionRunResponse:
    service = OrchestrationService(db, settings, adapter)
    return service.run_pipeline(payload, correlation_id=correlation_id)


@router.get("/runs/{run_id}", response_model=PredictionRunResponse)
def get_run(run_id: str, db: Session = Depends(get_db)) -> PredictionRunResponse:
    repo = PredictionRepository(db)
    run = repo.get_run_by_run_id(run_id)
    if run is None:
        raise NotFoundError(f"run {run_id} not found")
    return PredictionRunResponse.model_validate(run.response_payload)


@router.get("/{prediction_id}")
def get_prediction(prediction_id: str, db: Session = Depends(get_db)) -> dict:
    repo = PredictionRepository(db)
    prediction = repo.get_prediction(prediction_id)
    if prediction is None:
        raise NotFoundError(f"prediction {prediction_id} not found")
    return prediction.final_prediction
