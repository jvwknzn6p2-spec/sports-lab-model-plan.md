"""In-memory as-of stores for feature inputs.

These stand in for the DB tables the v1.1 skeleton anticipates (``handicap_lines``,
``human_predictions``). They exist so feature building and leakage tests run
without a live Postgres. The real system would back these with time-filtered SQL
(``WHERE published_at <= :as_of`` / ``submitted_at < :as_of``); the contract here
is identical.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from ..domain.events import require_aware


@dataclass(frozen=True, slots=True)
class HumanPrediction:
    event_id: uuid.UUID
    predictor_id: str
    role: str  # 'core4' | 'guest' | 'admin'
    pick_side: str  # 'A' | 'B'
    submitted_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "submitted_at", require_aware(self.submitted_at, "submitted_at"))


class HumanPredictionStore:
    def __init__(self) -> None:
        self._rows: list[HumanPrediction] = []

    def add(self, row: HumanPrediction) -> None:
        self._rows.append(row)

    def core4_picks_before(self, event_id: uuid.UUID, as_of: datetime) -> list[str]:
        """Core-4 picks strictly submitted before ``as_of`` (excludes future picks)."""
        as_of = require_aware(as_of, "as_of")
        return [
            r.pick_side
            for r in self._rows
            if r.event_id == event_id and r.role == "core4" and r.submitted_at < as_of
        ]
