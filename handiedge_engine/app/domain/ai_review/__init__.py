"""AI multi-agent review — Step 9 of the AI Sports Lab pipeline (model-plan §4.5).

A final sanity-check layer: three specialist reviewers (Data Auditor, Matchup
Analyst, Risk Reviewer) examine a finished prediction and its Control Tower
context, then attach warnings and, at most, *downgrade* the confidence tier —
never raising it and never rewriting a probability.

This is a Python port of the TypeScript ``lib/ai-review`` package
(``step-9-ai-multi-agent-review`` branch), integrated as a native HandiEdge
domain stage between the Decision Engine and prediction lock.
"""

from __future__ import annotations

from app.domain.ai_review.confidence import (
    apply_review,
    apply_review_to_tier,
    coarse_of_tier,
)
from app.domain.ai_review.context import build_review_context
from app.domain.ai_review.orchestrator import review_prediction
from app.domain.ai_review.provider import (
    AnthropicReviewProvider,
    HeuristicReviewProvider,
    ReviewProvider,
    default_provider,
)
from app.domain.ai_review.types import (
    AgentRole,
    AgentVerdict,
    ReviewContext,
    ReviewFlag,
    ReviewRank,
    ReviewResult,
    Severity,
)

__all__ = [
    "AgentRole",
    "AgentVerdict",
    "AnthropicReviewProvider",
    "HeuristicReviewProvider",
    "ReviewContext",
    "ReviewFlag",
    "ReviewProvider",
    "ReviewRank",
    "ReviewResult",
    "Severity",
    "apply_review",
    "apply_review_to_tier",
    "build_review_context",
    "coarse_of_tier",
    "default_provider",
    "review_prediction",
]
