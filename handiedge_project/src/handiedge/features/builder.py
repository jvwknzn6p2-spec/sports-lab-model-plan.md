"""As-of feature builder with leakage guards (audit category 5).

Every feature is computed from information available at an explicit ``as_of``
timestamp only. The builder:
- rejects naive (timezone-unaware) ``as_of`` (category 4 boundary check);
- reads odds only from lines published <= as_of (never the closing line for a
  pre-closing prediction);
- reads human-prediction aggregates only for picks submitted < as_of;
- produces a deterministic ``feature_hash`` so a served prediction's exact feature
  vector can be reconstructed and audited later.

The canonical leakage regression test asserts a feature value does NOT change when
future rows are appended to the sources (``tests/test_features.py``).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime

from ..domain.events import Event, require_aware
from ..domain.taxonomy import MarketType
from ..odds.ingestion import OddsIngestor
from .store import HumanPredictionStore


@dataclass(frozen=True, slots=True)
class FeatureVector:
    handicap_a: float
    handicap_open: float
    handicap_movement: float
    time_to_kickoff_min: float
    pct_core4_pick_a: float
    handicap_shift_since_open: float
    n_lines_seen: int
    n_core4_picks: int
    extras: dict[str, float] = field(default_factory=dict)

    def fingerprint(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def to_array(self) -> list[float]:
        """Stable ordered feature vector for model input."""
        return [
            self.handicap_a,
            self.handicap_movement,
            self.time_to_kickoff_min,
            self.pct_core4_pick_a,
            self.handicap_shift_since_open,
        ]


FEATURE_NAMES: tuple[str, ...] = (
    "handicap_a",
    "handicap_movement",
    "time_to_kickoff_min",
    "pct_core4_pick_a",
    "handicap_shift_since_open",
)


class FeatureBuilder:
    """Builds an as-of snapshot feature vector for one event's handicap market."""

    def __init__(self, ingestor: OddsIngestor, humans: HumanPredictionStore) -> None:
        self._ingestor = ingestor
        self._humans = humans

    def build(self, event: Event, as_of: datetime) -> FeatureVector:
        if as_of.tzinfo is None or as_of.tzinfo.utcoffset(as_of) is None:
            raise AssertionError("as_of must be timezone-aware")
        as_of = require_aware(as_of, "as_of")

        hist = self._ingestor.history(event.event_id, MarketType.HANDICAP)
        available = hist.as_of(as_of)
        latest = available[-1] if available else None
        opening = available[0] if available else None

        h_a = float(latest.line) if latest and latest.line is not None else 0.0
        h_open = float(opening.line) if opening and opening.line is not None else h_a
        ttk = max(0.0, (event.scheduled_at - as_of).total_seconds() / 60.0)

        picks = self._humans.core4_picks_before(event.event_id, as_of)
        pct_a = (sum(1 for p in picks if p == "A") / len(picks)) if picks else 0.5

        return FeatureVector(
            handicap_a=h_a,
            handicap_open=h_open,
            handicap_movement=h_a - h_open,
            time_to_kickoff_min=ttk,
            pct_core4_pick_a=pct_a,
            handicap_shift_since_open=h_a - h_open,
            n_lines_seen=len(available),
            n_core4_picks=len(picks),
        )


def new_trace_id() -> uuid.UUID:
    return uuid.uuid4()
