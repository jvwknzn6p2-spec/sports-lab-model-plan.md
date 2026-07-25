"""Data Auditor — the first reviewer in Step 9.

"Confirms inputs are present and reasonable; flags stale or missing data."
(model-plan §4.5). Deliberately deterministic-heavy: data completeness and
probability sanity are objective, so the guardrail pass does most of the work
and cannot be talked out of a critical flag by the model. The optional LLM pass
adds reasonableness judgment the fixed thresholds miss.
"""

from __future__ import annotations

from decimal import Decimal

from app.domain.ai_review.agents.shared import (
    cap_for_severity,
    llm_concerns_to_flags,
    merge_caps,
    serialize_context,
    worst_severity,
)
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

_AGENT = AgentRole.DATA_AUDITOR
# Probabilities in a complementary pair should sum to ~1.
_PROB_SUM_TOLERANCE = Decimal("0.02")

DATA_AUDITOR_SYSTEM = (
    "You are the Data Auditor for an MLB/NPB prediction system. Your only job is "
    "to judge whether the DATA behind a prediction is present, fresh, and "
    "internally consistent — not whether the pick is good.\n\n"
    "Focus on: missing or unconfirmed starting pitchers; missing betting odds "
    "(without them expected value is meaningless); missing batting, bullpen, "
    "weather, or park data; stale data; implausible values; and probabilities "
    "that do not add up.\n\n"
    "Report every concern with a severity and a SCREAMING_SNAKE_CASE code. Do not "
    "invent numbers or re-estimate the model. Set suggestedMaxRank to the best "
    "confidence rank the data quality can justify: 'C' if the data is unreliable "
    "enough that the pick is informational only, 'B' if there is a real gap but "
    "the pick still has substance, otherwise 'none'."
)


def _audit_rules(ctx: ReviewContext) -> tuple[list[ReviewFlag], ReviewRank | None]:
    flags: list[ReviewFlag] = []
    cap: ReviewRank | None = None

    def flag(
        severity: Severity, code: str, message: str, explicit_cap: ReviewRank | None = None
    ) -> None:
        nonlocal cap
        nonlocal_cap = explicit_cap if explicit_cap is not None else cap_for_severity(severity)
        flags.append(ReviewFlag(agent=_AGENT, severity=severity, code=code, message=message))
        cap = merge_caps(cap, nonlocal_cap)

    if not ctx.schedule_confirmed:
        flag(Severity.CRITICAL, "SCHEDULE_UNCONFIRMED", "Game schedule/time is not confirmed.")

    for side, pitcher in (("home", ctx.home_starter), ("away", ctx.away_starter)):
        if pitcher is None:
            flag(
                Severity.CRITICAL,
                "MISSING_STARTER",
                f"No starting pitcher listed for the {side} team.",
            )
        elif not pitcher.confirmed:
            flag(
                Severity.CRITICAL,
                "UNCONFIRMED_STARTER",
                f"{side} starter {pitcher.name} is projected, not confirmed.",
            )

    if not ctx.odds_available:
        flag(
            Severity.CRITICAL,
            "MISSING_ODDS",
            "No betting odds available — expected value cannot be computed.",
        )
    if not ctx.batting_stats_available:
        flag(Severity.WARNING, "MISSING_BATTING", "Team batting stats are missing.")
    if not ctx.bullpen_stats_available:
        flag(Severity.WARNING, "MISSING_BULLPEN", "Bullpen stats are missing.")
    if ctx.weather is None:
        flag(Severity.WARNING, "MISSING_WEATHER", "Weather data is missing (affects totals).")
    if not ctx.park_factors_available:
        flag(Severity.INFO, "MISSING_PARK_FACTORS", "Park-factor data is missing.")
    if not ctx.recent_form_available:
        flag(Severity.INFO, "MISSING_RECENT_FORM", "Recent-form data is missing.")

    if ctx.staleness_minutes is not None and ctx.staleness_minutes < 0:
        flag(Severity.WARNING, "BAD_FETCH_TIMESTAMP", "Data fetch timestamp is in the future.")

    prob_sum = ctx.home_win_prob + ctx.away_win_prob
    if (prob_sum - Decimal("1")).copy_abs() > _PROB_SUM_TOLERANCE:
        flag(
            Severity.CRITICAL,
            "PROB_SUM_INVALID",
            f"Win probabilities sum to {prob_sum:.3f}, not ~1.",
        )

    return flags, cap


def review_data_auditor(
    ctx: ReviewContext, provider: ReviewProvider
) -> AgentVerdict:
    flags, cap = _audit_rules(ctx)
    reasoning = ""
    source = VerdictSource.HEURISTIC

    if provider.available:
        outcome = provider.reason(
            ReasonRequest(system=DATA_AUDITOR_SYSTEM, context=serialize_context(ctx))
        )
        if outcome.ok and outcome.verdict is not None:
            flags.extend(llm_concerns_to_flags(_AGENT, outcome.verdict))
            cap = merge_caps(cap, outcome.verdict.suggested_max_rank)
            reasoning = outcome.verdict.overall_assessment
            source = VerdictSource.HEURISTIC_LLM
        else:
            reasoning = f"LLM review unavailable ({outcome.note}); deterministic checks only."

    worst = worst_severity(flags)
    if not reasoning:
        reasoning = (
            "Data is complete, fresh, and internally consistent."
            if worst is None
            else f"Found {len(flags)} data issue(s); most severe: {worst.value}."
        )

    return AgentVerdict(
        agent=_AGENT,
        ok=worst is None or worst is Severity.INFO,
        flags=tuple(flags),
        suggested_max_rank=cap,
        reasoning=reasoning,
        source=source,
    )
