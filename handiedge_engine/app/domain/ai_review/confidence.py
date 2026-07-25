"""Confidence arithmetic for the review layer.

The core invariant of Step 9 lives here: AI review can only ever *lower*
confidence, never raise it. Every function in this module is deterministic and
total, so the confidence math is fully auditable and testable without an LLM.

Two layers of ranks are reconciled here:

* :class:`ReviewRank` — the coarse S/A/B/C space the reviewers reason in.
* :class:`ConfidenceTier` — HandiEdge's fine 13-value tier (S+ .. C- / NONE)
  emitted by the Decision Engine.

The reviewers produce a coarse *cap*; :func:`apply_review_to_tier` folds that
cap back onto the fine tier such that the tier can only move to an equal or
lower position — never higher.
"""

from __future__ import annotations

from collections.abc import Iterable

from app.core.enums import ConfidenceTier
from app.domain.ai_review.types import AgentVerdict, ReviewRank

# Ordered best -> worst. Index doubles as the rank's numeric severity.
RANK_ORDER: tuple[ReviewRank, ...] = (
    ReviewRank.S,
    ReviewRank.A,
    ReviewRank.B,
    ReviewRank.C,
)


def rank_index(rank: ReviewRank) -> int:
    """Numeric position of a rank (0 = S, 3 = C). Higher = less confident."""

    return RANK_ORDER.index(rank)


def min_rank(a: ReviewRank, b: ReviewRank) -> ReviewRank:
    """Return the more conservative (lower-confidence) of two ranks."""

    return a if rank_index(a) >= rank_index(b) else b


def downgrade(rank: ReviewRank, steps: int) -> ReviewRank:
    """Drop a rank by ``steps``, clamped at the worst rank (C).

    Negative steps are treated as zero — this function never upgrades.
    """

    target = rank_index(rank) + max(0, int(steps))
    clamped = min(target, len(RANK_ORDER) - 1)
    return RANK_ORDER[clamped]


def cap_at(rank: ReviewRank, cap: ReviewRank) -> ReviewRank:
    """Apply a cap: the more conservative of the current rank and the cap.

    A cap can only hold the rank where it is or push it lower.
    """

    return min_rank(rank, cap)


def apply_review(original: ReviewRank, verdicts: Iterable[AgentVerdict]) -> ReviewRank:
    """Compute the final coarse rank from the original rank and every verdict.

    The result is the most conservative cap suggested by any agent, and is
    guaranteed to be equal to or lower than ``original``.
    """

    result = original
    for verdict in verdicts:
        if verdict.suggested_max_rank is not None:
            result = cap_at(result, verdict.suggested_max_rank)
    # Belt and suspenders: the loop can only lower the rank, but assert the
    # invariant explicitly so a future refactor cannot silently break it.
    return cap_at(original, result)


# --------------------------------------------------------------------------- #
# Fine-tier reconciliation
# --------------------------------------------------------------------------- #

# Ordered best -> worst; index is the tier's severity. NONE is the absolute floor.
TIER_ORDER: tuple[ConfidenceTier, ...] = (
    ConfidenceTier.S_PLUS,
    ConfidenceTier.S,
    ConfidenceTier.S_MINUS,
    ConfidenceTier.A_PLUS,
    ConfidenceTier.A,
    ConfidenceTier.A_MINUS,
    ConfidenceTier.B_PLUS,
    ConfidenceTier.B,
    ConfidenceTier.B_MINUS,
    ConfidenceTier.C_PLUS,
    ConfidenceTier.C,
    ConfidenceTier.C_MINUS,
    ConfidenceTier.NONE,
)

# The best (highest) fine tier permitted by each coarse cap. Capping at rank B,
# for instance, allows at most B+ — a genuine downgrade from any S/A tier, but a
# no-op for a tier already at or below B+.
_RANK_CEILING: dict[ReviewRank, ConfidenceTier] = {
    ReviewRank.S: ConfidenceTier.S_PLUS,
    ReviewRank.A: ConfidenceTier.A_PLUS,
    ReviewRank.B: ConfidenceTier.B_PLUS,
    ReviewRank.C: ConfidenceTier.C_PLUS,
}


def tier_index(tier: ConfidenceTier) -> int:
    return TIER_ORDER.index(tier)


def coarse_of_tier(tier: ConfidenceTier) -> ReviewRank:
    """Collapse a fine tier to its coarse S/A/B/C family (NONE -> C)."""

    letter = tier.value[0]
    if letter == "S":
        return ReviewRank.S
    if letter == "A":
        return ReviewRank.A
    if letter == "B":
        return ReviewRank.B
    # C+, C, C-, and NONE all collapse to the worst coarse rank.
    return ReviewRank.C


def ceiling_tier_for_rank(rank: ReviewRank) -> ConfidenceTier:
    """The best fine tier a coarse cap permits."""

    return _RANK_CEILING[rank]


def apply_review_to_tier(
    original_tier: ConfidenceTier, final_rank: ReviewRank
) -> ConfidenceTier:
    """Fold a coarse cap back onto the fine tier, never raising it.

    Returns the more conservative (higher-index) of the original tier and the
    cap's ceiling tier, so a same-family cap is a no-op and a worse-family cap
    downgrades to that family's best tier.
    """

    candidate = ceiling_tier_for_rank(final_rank)
    return original_tier if tier_index(original_tier) >= tier_index(candidate) else candidate
