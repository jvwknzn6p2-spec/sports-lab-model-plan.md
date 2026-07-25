"""Orchestrator for Step 9 — runs the three specialist agents over a review
context, aggregates their verdicts, and computes the reviewed confidence rank.

The three agents are independent reviewers of the same immutable prediction, so
they run in sequence over a frozen context and combine deterministically. The
AI-only-downgrades invariant is enforced in
:func:`app.domain.ai_review.confidence.apply_review`.
"""

from __future__ import annotations

from app.domain.ai_review.agents.data_auditor import review_data_auditor
from app.domain.ai_review.agents.matchup_analyst import review_matchup_analyst
from app.domain.ai_review.agents.risk_reviewer import review_risk_reviewer
from app.domain.ai_review.confidence import apply_review, rank_index
from app.domain.ai_review.provider import HeuristicReviewProvider, ReviewProvider
from app.domain.ai_review.types import (
    AgentVerdict,
    ReviewContext,
    ReviewFlag,
    ReviewResult,
    Severity,
)

_SEVERITY_SORT: dict[Severity, int] = {
    Severity.CRITICAL: 0,
    Severity.WARNING: 1,
    Severity.INFO: 2,
}


def _sort_flags(flags: list[ReviewFlag]) -> tuple[ReviewFlag, ...]:
    """Sort flags most-severe first, stable within a severity."""

    return tuple(sorted(flags, key=lambda f: _SEVERITY_SORT[f.severity]))


def _build_warnings(
    flags: tuple[ReviewFlag, ...], original: str, final: str
) -> tuple[str, ...]:
    lines = [
        f"[{f.severity.value.upper()}] ({f.agent.value}) {f.message}"
        for f in flags
        if f.severity is not Severity.INFO
    ]
    if final != original:
        lines.insert(0, f"Confidence downgraded {original} -> {final} after AI review.")
    return tuple(lines)


def review_prediction(
    ctx: ReviewContext,
    provider: ReviewProvider | None = None,
    reviewed_at: str = "",
) -> ReviewResult:
    """Review a single prediction context with all three agents."""

    prov = provider or HeuristicReviewProvider()

    verdicts: tuple[AgentVerdict, ...] = (
        review_data_auditor(ctx, prov),
        review_matchup_analyst(ctx, prov),
        review_risk_reviewer(ctx, prov),
    )

    final_rank = apply_review(ctx.original_tier_rank, verdicts)
    flags = _sort_flags([f for v in verdicts for f in v.flags])
    downgraded = rank_index(final_rank) > rank_index(ctx.original_tier_rank)

    return ReviewResult(
        match_id=ctx.match_id,
        prediction_id=ctx.prediction_id,
        original_rank=ctx.original_tier_rank,
        final_rank=final_rank,
        downgraded=downgraded,
        verdicts=verdicts,
        flags=flags,
        warnings=_build_warnings(flags, ctx.original_tier_rank.value, final_rank.value),
        reviewed_at=reviewed_at,
    )
