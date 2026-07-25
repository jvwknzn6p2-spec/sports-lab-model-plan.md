"""Abstention / no-bet contract (audit category 6).

The system must be able to decline to pick when confidence is low, the edge is
insufficient, or the input is out-of-distribution (e.g. too little history). This
is a first-class outcome, not a fabricated low-confidence pick.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class AbstainReason(str, Enum):
    LOW_CONFIDENCE = "low_confidence"
    INSUFFICIENT_EDGE = "insufficient_edge"
    OUT_OF_DISTRIBUTION = "out_of_distribution"
    INSUFFICIENT_HISTORY = "insufficient_history"
    STALE_ODDS = "stale_odds"


@dataclass(frozen=True, slots=True)
class AbstentionPolicy:
    min_edge: float = 0.02  # required fair-prob edge over the market
    min_confidence: float = 0.55  # |p - 0.5| mapped: require prob outside [1-c, c]
    min_history_lines: int = 1  # need at least this many odds lines seen
    min_core4_picks: int = 0

    def evaluate(
        self,
        *,
        prob_a: float,
        edge: float,
        n_lines_seen: int,
        n_core4_picks: int,
    ) -> AbstainReason | None:
        """Return an abstain reason, or None if a bet may be placed."""
        if n_lines_seen < self.min_history_lines:
            return AbstainReason.INSUFFICIENT_HISTORY
        if n_core4_picks < self.min_core4_picks:
            return AbstainReason.INSUFFICIENT_HISTORY
        confidence = max(prob_a, 1.0 - prob_a)
        if confidence < self.min_confidence:
            return AbstainReason.LOW_CONFIDENCE
        if abs(edge) < self.min_edge:
            return AbstainReason.INSUFFICIENT_EDGE
        return None
