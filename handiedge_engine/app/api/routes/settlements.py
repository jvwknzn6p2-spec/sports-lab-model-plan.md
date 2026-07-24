"""Settlement endpoints."""

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
from app.schemas.settlement import SettlementInput, SettlementResponse
from app.services.settlement_service import SettlementService

router = APIRouter(prefix="/api/v1/settlements", tags=["settlements"])


@router.post("", response_model=SettlementResponse, dependencies=[Depends(require_api_key)])
def create_settlement(
    body: SettlementInput,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    correlation_id: str = Depends(get_correlation_id),
) -> SettlementResponse:
    service = SettlementService(db, settings)
    return service.settle(body, correlation_id=correlation_id)


@router.get("/{settlement_id}", response_model=SettlementResponse)
def get_settlement(
    settlement_id: str,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> SettlementResponse:
    service = SettlementService(db, settings)
    return service.get(settlement_id)
