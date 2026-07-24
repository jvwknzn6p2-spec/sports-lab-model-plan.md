"""Settlement input/output schemas."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.enums import GameStatus, PredictionResult, SettlementStatus


class Score(BaseModel):
    model_config = ConfigDict(frozen=True)

    home: int = Field(ge=0)
    away: int = Field(ge=0)


class SettlementInput(BaseModel):
    """Official result handoff used to settle a locked prediction."""

    prediction_lock_id: str = Field(min_length=1)
    official_game_id: str | None = None
    final_score: Score | None = None
    regulation_score: Score | None = None
    extra_innings_score: Score | None = None
    game_status: GameStatus
    postponement_status: bool = False
    cancellation_status: bool = False
    official_result_source: str = Field(min_length=1)
    official_result_timestamp: datetime
    settlement_timestamp: datetime | None = None

    @model_validator(mode="after")
    def _validate(self) -> SettlementInput:
        if self.game_status is GameStatus.FINAL and (
            self.final_score is None and self.regulation_score is None
        ):
            raise ValueError("FINAL game requires final_score or regulation_score")
        return self


class SettlementResponse(BaseModel):
    settlement_id: str
    prediction_lock_id: str
    normal_prediction_result: PredictionResult
    handicap_prediction_result: PredictionResult
    settlement_status: SettlementStatus
    winning_team: str | None = None
    losing_team: str | None = None
    settlement_score_home: int | None = None
    settlement_score_away: int | None = None
    push: bool = False
    partial_win: bool = False
    partial_loss: bool = False
    void_reason: str | None = None
    result_source: str | None = None
    result_timestamp: str | None = None
    settlement_rule_version: str
    settlement_scope: str
