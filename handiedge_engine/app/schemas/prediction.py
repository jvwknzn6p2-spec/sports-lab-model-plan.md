"""Raw prediction output schema (Prediction Engine layer) and the final
prediction response contract (Output Contract, section 20)."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import ModelType


class RawGamePrediction(BaseModel):
    """Per-game output of a prediction adapter, before decisioning."""

    model_config = ConfigDict(frozen=True)

    match_id: str
    raw_home_win_probability: Decimal
    raw_away_win_probability: Decimal
    raw_team_score_expectations: dict[str, Decimal] = Field(default_factory=dict)
    raw_margin_distribution: dict[str, Decimal] | None = None
    feature_snapshot_id: str | None = None
    inference_warnings: tuple[str, ...] = ()
    fallback_used: bool = False


class PredictionModelContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    model_id: str
    model_version: str
    model_type: ModelType
    inference_timestamp: datetime
    fallback_used: bool = False


class RawPredictionBundle(BaseModel):
    """Complete raw prediction output for a run."""

    model_config = ConfigDict(frozen=True)

    context: PredictionModelContext
    games: tuple[RawGamePrediction, ...]


# --------------------------------------------------------------------------- #
# Final output contract (typed response model)
# --------------------------------------------------------------------------- #


class ModelContextOut(BaseModel):
    model_id: str
    model_version: str
    fallback_used: bool


class CalibrationContextOut(BaseModel):
    method: str
    status: str
    artifact_id: str | None = None
    version: str | None = None
    warning: str | None = None


class ExpectedScoreOut(BaseModel):
    home: float | None = None
    away: float | None = None


class GameAuditOut(BaseModel):
    prediction_id: str
    input_hash: str
    feature_snapshot_id: str | None = None
    created_at: str


class GamePredictionOut(BaseModel):
    match_id: str
    home: str
    away: str
    selected_team: str | None = None
    predicted_loser: str | None = None
    normal_win_probability: float | None = None
    normal_loss_probability: float | None = None
    handicap_pick: str | None = None
    handicap_cover_probability: float | None = None
    confidence_tier: str
    risk_level: str
    expected_score: ExpectedScoreOut = Field(default_factory=ExpectedScoreOut)
    decision_status: str
    pass_reason: str | None = None
    supporting_factors: list[str] = Field(default_factory=list)
    risk_factors: list[str] = Field(default_factory=list)
    calibration_notes: list[str] = Field(default_factory=list)
    data_quality_status: str
    handicap_rule_status: str
    audit: GameAuditOut


class PredictionSummaryOut(BaseModel):
    total_games: int
    predictions: int
    passes: int
    blocked: int
    fallback_predictions: int


class PredictionRunResponse(BaseModel):
    """The final locked-shape prediction output (section 20)."""

    schema_version: str
    run_id: str
    league: str
    slate_date: str
    generated_at: str
    control_tower_status: str
    prediction_status: str
    model_context: ModelContextOut
    calibration_context: CalibrationContextOut
    games: list[GamePredictionOut]
    summary: PredictionSummaryOut
