"""Output contract for the AI multi-agent review layer (Step 9).

Attached to each :class:`GamePredictionOut` so the review is fully auditable in
the locked prediction payload: every agent's verdict, every flag, and the exact
tier movement are preserved alongside the numbers they reviewed.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AiReviewFlagOut(BaseModel):
    agent: str
    severity: str
    code: str
    message: str


class AiReviewVerdictOut(BaseModel):
    agent: str
    ok: bool
    suggested_max_rank: str | None = None
    reasoning: str
    source: str
    flags: list[AiReviewFlagOut] = Field(default_factory=list)


class AiReviewOut(BaseModel):
    """The aggregated review result for one game."""

    reviewed: bool
    original_rank: str
    final_rank: str
    original_tier: str
    final_tier: str
    downgraded: bool
    provider: str
    reviewed_at: str
    warnings: list[str] = Field(default_factory=list)
    flags: list[AiReviewFlagOut] = Field(default_factory=list)
    verdicts: list[AiReviewVerdictOut] = Field(default_factory=list)
