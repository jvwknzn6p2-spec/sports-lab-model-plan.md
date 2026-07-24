"""Self-Learning workflow schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.enums import LearningWorkflowStatus


class LearningWorkflowCreate(BaseModel):
    settlement_id: str = Field(min_length=1)
    league: str
    season_segment: str | None = None
    created_by: str = "system"


class WorkflowAdvanceRequest(BaseModel):
    target_status: LearningWorkflowStatus | None = Field(
        default=None,
        description="Optional explicit target; if omitted advances to the next valid stage.",
    )
    approved_by: str | None = None
    reason: str | None = None
    metrics: dict[str, float] = Field(default_factory=dict)


class LearningWorkflowResponse(BaseModel):
    workflow_id: str
    settlement_id: str
    league: str
    status: LearningWorkflowStatus
    dataset_version: str | None = None
    feature_version: str | None = None
    model_version: str | None = None
    calibration_version: str | None = None
    history: list[dict[str, Any]] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
    blockers: list[str] = Field(default_factory=list)
