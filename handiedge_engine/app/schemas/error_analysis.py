"""Error Analysis Engine schemas."""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, Field

from app.core.enums import ErrorCategory


class Hypothesis(BaseModel):
    statement: str
    confidence: Decimal = Field(ge=0, le=1)
    supporting_evidence: list[str] = Field(default_factory=list)


class ErrorAnalysisResponse(BaseModel):
    error_analysis_id: str
    settlement_id: str
    prediction_lock_id: str
    prediction_error: Decimal | None = None
    brier_contribution: Decimal | None = None
    log_loss_contribution: Decimal | None = None
    calibration_bucket: str | None = None
    expected_margin_error: Decimal | None = None
    actual_margin: int | None = None
    primary_error_category: ErrorCategory
    secondary_error_categories: list[ErrorCategory] = Field(default_factory=list)
    observed_evidence: list[str] = Field(default_factory=list)
    derived_metrics: dict[str, float] = Field(default_factory=dict)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    recommended_follow_up: list[str] = Field(default_factory=list)
    retraining_eligibility: bool = False
