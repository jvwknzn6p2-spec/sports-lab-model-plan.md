"""Canonical event / market / selection models.

All timestamps are timezone-aware UTC. Naive datetimes are rejected at the
boundary (audit category 4). ``event_id`` is a stable UUID used as the join key
across ingestion → features → predictions → settlement.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .taxonomy import LEAGUES_BY_SPORT, MarketType, Side, Sport, is_valid_league


def require_aware(ts: datetime, name: str) -> datetime:
    """Reject naive datetimes and normalise to UTC (audit category 4)."""
    if ts.tzinfo is None or ts.tzinfo.utcoffset(ts) is None:
        raise ValueError(f"{name} must be timezone-aware")
    return ts.astimezone(UTC)


@dataclass(frozen=True, slots=True)
class Event:
    event_id: uuid.UUID
    sport: Sport
    league: str
    team_home: str
    team_away: str
    scheduled_at: datetime  # UTC, kickoff / first-pitch
    original_tz: str = "UTC"  # preserve the original local zone as metadata
    venue: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "scheduled_at", require_aware(self.scheduled_at, "scheduled_at"))
        if not is_valid_league(self.sport, self.league):
            allowed = sorted(LEAGUES_BY_SPORT.get(self.sport, frozenset()))
            raise ValueError(f"league {self.league!r} invalid for {self.sport}; allowed={allowed}")

    @staticmethod
    def new_id() -> uuid.UUID:
        return uuid.uuid4()


@dataclass(frozen=True, slots=True)
class Market:
    """A specific betting market on an event."""

    event_id: uuid.UUID
    market_type: MarketType
    draw_allowed: bool = False
    # The reference line for handicap/total markets (points on side A / over).
    line: float | None = None


@dataclass(frozen=True, slots=True)
class Selection:
    """A single pickable outcome within a market."""

    event_id: uuid.UUID
    market_type: MarketType
    side: Side


@dataclass(slots=True)
class EventOutcome:
    """Final settled outcome of an event, used only for settlement (never as a feature)."""

    event_id: uuid.UUID
    score_home: int
    score_away: int
    voided: bool = False  # rain-out, abandonment, etc.
    settled_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        self.settled_at = require_aware(self.settled_at, "settled_at")
