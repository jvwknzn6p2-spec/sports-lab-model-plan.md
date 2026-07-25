"""Typed, connector-agnostic records for fixtures, odds snapshots and results.

These preserve the *canonical OpticOdds identifiers* (fixture id, game id, team
ids, sportsbook, player id) so records join cleanly across sync → dataset →
settlement. NPB fields that OpticOdds may omit (starters, records, broadcast) are
explicitly ``Optional`` and never fabricated.

Deep links and raw sportsbook payloads are intentionally NOT modelled here — they
are volatile and must not be persisted into datasets or committed to test fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime


@dataclass(frozen=True, slots=True)
class Competitor:
    """A team/side on a fixture. ``team_id`` is the canonical OpticOdds id."""

    team_id: str
    name: str
    abbreviation: str | None = None
    record: str | None = None  # e.g. "10-5"; frequently null for NPB
    starter_id: str | None = None
    starter_name: str | None = None


@dataclass(frozen=True, slots=True)
class FixtureRecord:
    """A normalized fixture. Times are UTC internally; local zone is display-only."""

    fixture_id: str  # canonical OpticOdds fixture id (preserved verbatim)
    game_id: str | None
    league: str  # OpticOdds league id, e.g. "mlb" / "npb"
    start_time: datetime  # UTC
    status: str
    is_live: bool
    has_odds: bool
    home: Competitor
    away: Competitor
    venue: str | None = None
    season_year: int | None = None
    season_type: str | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class OddsSnapshotRow:
    """One sportsbook price for one selection, captured at a point in time.

    ``price`` is decimal odds. ``points`` is the handicap/total line (nullable for
    moneyline). ``captured_at`` is when we took the snapshot; ``published_at`` is the
    book's own timestamp (epoch -> UTC). Deep links are deliberately dropped.
    """

    fixture_id: str
    league: str
    sportsbook: str
    market_id: str  # "moneyline" | "run_line" | "total_runs"
    selection: str
    normalized_selection: str
    price: float  # decimal odds
    points: float | None
    published_at: datetime  # UTC (from book timestamp)
    captured_at: datetime  # UTC (our snapshot time)
    is_main: bool = True
    team_id: str | None = None
    player_id: str | None = None
    grouping_key: str | None = None


@dataclass(frozen=True, slots=True)
class ResultRecord:
    """A completed-fixture result used only to build labels (never a feature)."""

    fixture_id: str
    league: str
    home_score: int | None
    away_score: int | None
    status: str  # "completed" | "pending" | "cancelled" | ...
    is_final: bool
    voided: bool = False
    retrieved_at: datetime = field(default_factory=lambda: datetime.now(UTC))
