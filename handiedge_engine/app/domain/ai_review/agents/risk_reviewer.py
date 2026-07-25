"""Risk Reviewer — the third and final reviewer in Step 9.

"Challenges over-confident picks and can downgrade the confidence rank."
(model-plan §4.5). Adversarial by design: it assumes a high-confidence pick must
earn that confidence and looks for reasons it should not hold. The deterministic
pass encodes the objective over-confidence signals (thin edge, low component
agreement, coin-flip picks); the LLM pass argues the harder cases.
"""

from __future__ import annotations

from decimal import Decimal

from app.domain.ai_review.agents.shared import (
    llm_concerns_to_flags,
    merge_caps,
    serialize_context,
    worst_severity,
)
from app.domain.ai_review.confidence import rank_index
from app.domain.ai_review.provider import ReasonRequest, ReviewProvider
from app.domain.ai_review.types import (
    AgentRole,
    AgentVerdict,
    ReviewContext,
    ReviewFlag,
    ReviewRank,
    Severity,
    VerdictSource,
)

_AGENT = AgentRole.RISK_REVIEWER
# Below this, the model's components disagree enough to distrust an S/A pick.
_MIN_AGREEMENT_FOR_HIGH = Decimal("0.6")
# A "high confidence" pick needs a real edge; below this it's thin.
_MIN_EDGE_FOR_HIGH = Decimal("0.03")
# Moneyline gap below this is effectively a coin flip.
_COIN_FLIP_GAP = Decimal("0.04")

RISK_REVIEWER_SYSTEM = (
    "You are the Risk Reviewer for an MLB/NPB prediction system — the last check "
    "before a pick is published. Be skeptical: assume a high confidence rank (S or "
    "A) is wrong until the evidence clearly earns it. Challenge over-confidence, "
    "never boost it.\n\n"
    "Baseball is high-variance and sportsbook lines are sharp, so real edges are "
    "small. Push back when: components disagree but the rank is high; the market "
    "edge is thin relative to the confidence claimed; the moneyline is near a coin "
    "flip but the rank is better than C; or the pick rests on a single fragile "
    "assumption.\n\n"
    "For each concern give a severity and a SCREAMING_SNAKE_CASE code. Set "
    "suggestedMaxRank to the highest rank the evidence justifies after variance: "
    "'B' or 'C' when the pick is over-confident, 'none' only when the confidence is "
    "genuinely earned. You may cap the rank; you may never raise it."
)


def _risk_rules(ctx: ReviewContext) -> tuple[list[ReviewFlag], ReviewRank | None]:
    flags: list[ReviewFlag] = []
    cap: ReviewRank | None = None

    def flag(severity: Severity, code: str, message: str, proposed_cap: ReviewRank) -> None:
        nonlocal cap
        flags.append(ReviewFlag(agent=_AGENT, severity=severity, code=code, message=message))
        cap = merge_caps(cap, proposed_cap)

    is_high = rank_index(ctx.original_tier_rank) <= rank_index(ReviewRank.A)  # S or A

    if (
        is_high
        and ctx.component_agreement is not None
        and ctx.component_agreement < _MIN_AGREEMENT_FOR_HIGH
    ):
        flag(
            Severity.WARNING,
            "LOW_COMPONENT_AGREEMENT",
            f"Rank {ctx.original_tier_rank.value} but component agreement is "
            f"{ctx.component_agreement:.2f} (< {_MIN_AGREEMENT_FOR_HIGH}).",
            ReviewRank.B,
        )

    if is_high and ctx.market_edge is not None and ctx.market_edge < _MIN_EDGE_FOR_HIGH:
        flag(
            Severity.WARNING,
            "THIN_EDGE",
            f"Rank {ctx.original_tier_rank.value} but market edge is only "
            f"{ctx.market_edge * 100:.1f}%.",
            ReviewRank.B,
        )

    ml_gap = (ctx.home_win_prob - ctx.away_win_prob).copy_abs()
    if ml_gap < _COIN_FLIP_GAP and rank_index(ctx.original_tier_rank) < rank_index(ReviewRank.C):
        flag(
            Severity.WARNING,
            "COIN_FLIP",
            f"Moneyline is near a coin flip ({ml_gap * 100:.1f}% gap) but rank is "
            f"{ctx.original_tier_rank.value}.",
            ReviewRank.C,
        )

    return flags, cap


def review_risk_reviewer(
    ctx: ReviewContext, provider: ReviewProvider
) -> AgentVerdict:
    flags, cap = _risk_rules(ctx)
    reasoning = ""
    source = VerdictSource.HEURISTIC

    if provider.available:
        outcome = provider.reason(
            ReasonRequest(system=RISK_REVIEWER_SYSTEM, context=serialize_context(ctx))
        )
        if outcome.ok and outcome.verdict is not None:
            flags.extend(llm_concerns_to_flags(_AGENT, outcome.verdict))
            cap = merge_caps(cap, outcome.verdict.suggested_max_rank)
            reasoning = outcome.verdict.overall_assessment
            source = VerdictSource.HEURISTIC_LLM
        else:
            reasoning = f"LLM review unavailable ({outcome.note}); deterministic risk checks only."
    else:
        reasoning = "Deterministic risk checks only (no LLM provider)."

    worst = worst_severity(flags)
    return AgentVerdict(
        agent=_AGENT,
        ok=worst is None or worst is Severity.INFO,
        flags=tuple(flags),
        suggested_max_rank=cap,
        reasoning=reasoning,
        source=source,
    )
