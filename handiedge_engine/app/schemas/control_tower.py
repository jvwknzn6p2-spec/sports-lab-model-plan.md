"""Strict Pydantic v2 schema for the Control Tower handoff payload.

This is the single entry contract for the whole engine. Validation here is
intentionally strict: malformed, contradictory, or under-specified records are
rejected rather than silently repaired.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.enums import (
    ControlTowerStatus,
    DataQualityStatus,
    League,
    SettlementScope,
    Sport,
    ValidationStatus,
)

# Which settlement scopes are valid for each league. Cross-league scopes are
# rejected — never silently substituted.
LEAGUE_SCOPE_MAP: dict[League, SettlementScope] = {
    League.MLB: SettlementScope.MLB_FINAL_INCL_EXTRA,
    League.NPB: SettlementScope.NPB_REG9_ONLY,
}


class SourceFreshness(BaseModel):
    model_config = ConfigDict(extra="allow")

    odds_fetched_at: datetime | None = None
    lineup_fetched_at: datetime | None = None
    weather_fetched_at: datetime | None = None
    schedule_fetched_at: datetime | None = None


class ValidationSummary(BaseModel):
    model_config = ConfigDict(extra="allow")

    checks_passed: int = 0
    checks_failed: int = 0
    notes: list[str] = Field(default_factory=list)


class EvidenceRef(BaseModel):
    """A reference to an upstream evidence artifact."""

    model_config = ConfigDict(extra="allow")

    ref_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    uri: str | None = None
    quality: DataQualityStatus = DataQualityStatus.OK

    @field_validator("ref_id", "kind")
    @classmethod
    def _no_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("evidence reference fields must be non-empty")
        return v


class GameFeatureSummary(BaseModel):
    """Bag of feature-ish summaries. Kept permissive but never auto-filled."""

    model_config = ConfigDict(extra="allow")

    feature_snapshot_id: str | None = None
    completeness: float | None = Field(default=None, ge=0.0, le=1.0)
    missing_features: list[str] = Field(default_factory=list)


class ProbableStarter(BaseModel):
    model_config = ConfigDict(extra="allow")

    team: str
    name: str | None = None
    confirmed: bool = False


class ControlTowerGame(BaseModel):
    """A single game record inside a Control Tower run."""

    model_config = ConfigDict(extra="allow")

    match_id: str = Field(min_length=1)
    official_game_id: str | None = None
    listed_team: str
    opponent: str
    home: str
    away: str
    favorite: str | None = None
    receiver: str | None = None
    home_away_status: str | None = None
    validation_status: ValidationStatus = ValidationStatus.UNVALIDATED
    scheduled_start: datetime | None = None

    probable_or_confirmed_starters: list[ProbableStarter] = Field(default_factory=list)
    starter_status: str | None = None

    odds_summary: dict[str, Any] = Field(default_factory=dict)
    market_summary: dict[str, Any] = Field(default_factory=dict)
    weather_summary: dict[str, Any] = Field(default_factory=dict)
    lineup_summary: dict[str, Any] = Field(default_factory=dict)
    bullpen_summary: dict[str, Any] = Field(default_factory=dict)
    feature_summary: GameFeatureSummary = Field(default_factory=GameFeatureSummary)
    risk_summary: dict[str, Any] = Field(default_factory=dict)
    evidence: list[EvidenceRef] = Field(default_factory=list)

    # Handicap source fields (parsed by the handicap bounded context downstream).
    handicap_raw: str | None = None
    handicap_display: str | None = None
    handicap_type: str | None = None
    handicap_value: float | None = None
    handicap_sub_number: int | None = None
    handicap_settlement_rule: str | None = None

    @field_validator("match_id", "listed_team", "opponent", "home", "away")
    @classmethod
    def _non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("field must be a non-empty string")
        return v

    @model_validator(mode="after")
    def _validate_teams(self) -> ControlTowerGame:
        if self.home.strip().lower() == self.away.strip().lower():
            raise ValueError(f"home and away teams are identical: {self.home!r}")
        teams = {self.home.strip().lower(), self.away.strip().lower()}
        listed = {self.listed_team.strip().lower(), self.opponent.strip().lower()}
        if listed != teams:
            raise ValueError(
                "listed_team/opponent must match the home/away pair "
                f"(got {sorted(listed)} vs {sorted(teams)})"
            )
        if self.favorite and self.favorite.strip().lower() not in teams:
            raise ValueError("favorite must be one of the two teams")
        if self.receiver and self.receiver.strip().lower() not in teams:
            raise ValueError("receiver must be one of the two teams")
        if (
            self.favorite
            and self.receiver
            and self.favorite.strip().lower() == self.receiver.strip().lower()
        ):
            raise ValueError("favorite and receiver cannot be the same team")
        return self


class ControlTowerPayload(BaseModel):
    """Top-level Control Tower run payload."""

    model_config = ConfigDict(extra="forbid")

    schema_version: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    league: League
    sport: Sport = Sport.BASEBALL
    slate_date: date
    timezone: str = "UTC"
    generated_at: datetime
    prediction_deadline: datetime
    settlement_scope: SettlementScope
    data_quality_status: DataQualityStatus = DataQualityStatus.OK
    control_tower_status: ControlTowerStatus = ControlTowerStatus.PASS
    source_freshness: SourceFreshness = Field(default_factory=SourceFreshness)
    validation_summary: ValidationSummary = Field(default_factory=ValidationSummary)
    games: list[ControlTowerGame] = Field(min_length=1)

    @model_validator(mode="after")
    def _validate_run(self) -> ControlTowerPayload:
        # League <-> settlement scope must be consistent. Never substitute.
        expected = LEAGUE_SCOPE_MAP.get(self.league)
        if expected is None:
            raise ValueError(f"unsupported league: {self.league}")
        if self.settlement_scope != expected:
            raise ValueError(
                f"settlement_scope {self.settlement_scope} is inconsistent with "
                f"league {self.league} (expected {expected})"
            )
        if self.prediction_deadline < self.generated_at:
            raise ValueError("prediction_deadline cannot be before generated_at")

        seen_match_ids: set[str] = set()
        for game in self.games:
            if game.match_id in seen_match_ids:
                raise ValueError(f"duplicate match_id in run: {game.match_id}")
            seen_match_ids.add(game.match_id)
        return self
