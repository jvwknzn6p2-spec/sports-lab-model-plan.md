"""Self-learning workflow endpoints."""

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
from app.schemas.learning import (
    LearningWorkflowCreate,
    LearningWorkflowResponse,
    WorkflowAdvanceRequest,
)
from app.services.self_learning_service import SelfLearningService

router = APIRouter(prefix="/api/v1/learning/workflows", tags=["learning"])


@router.post("", response_model=LearningWorkflowResponse, dependencies=[Depends(require_api_key)])
def create_workflow(
    body: LearningWorkflowCreate,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    correlation_id: str = Depends(get_correlation_id),
) -> LearningWorkflowResponse:
    service = SelfLearningService(db, settings)
    return service.create(body, correlation_id=correlation_id)


@router.get("/{workflow_id}", response_model=LearningWorkflowResponse)
def get_workflow(
    workflow_id: str,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> LearningWorkflowResponse:
    service = SelfLearningService(db, settings)
    return service.get(workflow_id)


@router.post(
    "/{workflow_id}/advance",
    response_model=LearningWorkflowResponse,
    dependencies=[Depends(require_api_key)],
)
def advance_workflow(
    workflow_id: str,
    body: WorkflowAdvanceRequest,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
    correlation_id: str = Depends(get_correlation_id),
) -> LearningWorkflowResponse:
    service = SelfLearningService(db, settings)
    return service.advance(
        workflow_id,
        target=body.target_status,
        metrics=body.metrics,
        approved_by=body.approved_by,
        reason=body.reason,
        correlation_id=correlation_id,
    )
