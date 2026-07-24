"""Prediction lock request/response schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.core.enums import LockStatus


class LockRequest(BaseModel):
    created_by: str = "system"
    supersede: bool = Field(
        default=False,
        description="If true, supersede an existing LOCKED prediction with a new version.",
    )


class LockResponse(BaseModel):
    prediction_lock_id: str
    run_id: str
    match_id: str
    prediction_id: str
    locked_at: str
    lock_deadline: str
    input_payload_hash: str
    feature_snapshot_hash: str | None = None
    model_id: str
    model_version: str
    calibration_version: str
    decision_policy_version: str
    lock_status: LockStatus
    version: int
    created_by: str
    final_prediction: dict[str, Any]
