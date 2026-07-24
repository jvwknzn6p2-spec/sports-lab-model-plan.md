"""Error-analysis endpoints."""

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
from app.schemas.error_analysis import ErrorAnalysisResponse
from app.services.error_analysis_service import ErrorAnalysisService

router = APIRouter(prefix="/api/v1/error-analysis", tags=["error-analysis"])


@router.post(
    "/{settlement_id}",
    response_model=ErrorAnalysisResponse,
    dependencies=[Depends(require_api_key)],
)
def create_error_analysis(
    settlement_id: str,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    correlation_id: str = Depends(get_correlation_id),
) -> ErrorAnalysisResponse:
    service = ErrorAnalysisService(db, settings)
    return service.analyze_settlement(settlement_id, correlation_id=correlation_id)


@router.get("/{error_analysis_id}", response_model=ErrorAnalysisResponse)
def get_error_analysis(
    error_analysis_id: str,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> ErrorAnalysisResponse:
    service = ErrorAnalysisService(db, settings)
    return service.get(error_analysis_id)
