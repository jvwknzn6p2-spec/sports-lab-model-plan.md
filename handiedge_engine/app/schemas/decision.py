"""Decision Engine output schemas (normal + handicap)."""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import (
    ConfidenceTier,
    DecisionStatus,
    HandicapDecisionStatus,
    HandicapSide,
    RiskLevel,
)


class HandicapDecision(BaseModel):
    """Handicap cover evaluation — independent from the normal win decision."""

    model_config = ConfigDict(frozen=True)

    handicap_pick: str | None = None
    handicap_side: HandicapSide | None = None
    handicap_cover_probability: Decimal | None = None
    handicap_push_probability: Decimal | None = None
    handicap_partial_win_probability: Decimal | None = None
    handicap_partial_loss_probability: Decimal | None = None
    handicap_rule_status: str = "UNRESOLVED"
    handicap_decision_status: HandicapDecisionStatus = HandicapDecisionStatus.UNAVAILABLE
    handicap_pass_reason: str | None = None


class GameDecision(BaseModel):
    """Complete operational decision for one game."""

    model_config = ConfigDict(frozen=True)

    match_id: str
    selected_team: str | None = None
    predicted_loser: str | None = None
    normal_win_probability: Decimal | None = None
    normal_loss_probability: Decimal | None = None
    confidence_tier: ConfidenceTier = ConfidenceTier.NONE
    risk_level: RiskLevel = RiskLevel.MEDIUM
    decision_status: DecisionStatus = DecisionStatus.PASS
    pass_reason: str | None = None
    supporting_factors: tuple[str, ...] = ()
    risk_factors: tuple[str, ...] = ()
    calibration_notes: tuple[str, ...] = ()
    expected_score_home: Decimal | None = None
    expected_score_away: Decimal | None = None
    handicap: HandicapDecision = Field(default_factory=HandicapDecision)
