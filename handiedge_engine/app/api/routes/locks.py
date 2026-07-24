"""Prediction lock endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import (
    get_correlation_id,
    get_db,
    get_settings_dep,
    require_api_key,
)
from app.core.config import Settings
from app.schemas.lock import LockRequest, LockResponse
from app.services.prediction_lock_service import PredictionLockService

router = APIRouter(prefix="/api/v1", tags=["locks"])


@router.post(
    "/predictions/{prediction_id}/lock",
    response_model=LockResponse,
    dependencies=[Depends(require_api_key)],
)
def lock_prediction(
    prediction_id: str,
    body: LockRequest | None = None,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    correlation_id: str = Depends(get_correlation_id),
) -> LockResponse:
    body = body or LockRequest()
    service = PredictionLockService(db, settings)
    return service.lock(
        prediction_id,
        created_by=body.created_by,
        supersede=body.supersede,
        correlation_id=correlation_id,
    )


@router.get("/locks/{prediction_lock_id}", response_model=LockResponse)
def get_lock(
    prediction_lock_id: str,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> LockResponse:
    service = PredictionLockService(db, settings)
    return service.get(prediction_lock_id)
