"""Matchup Analyst — the second reviewer in Step 9.

"Reviews the pick against qualitative context (injury news, pitcher trends)."
(model-plan §4.5). LLM-first: its value is mostly qualitative. A thin
deterministic pass guards the two cases objective enough to catch without a
model — a key injury on the side being picked, and weather that plainly
contradicts the total lean.
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

_AGENT = AgentRole.MATCHUP_ANALYST
# A moneyline lean this strong is "the pick leans on that team".
_STRONG_LEAN_PROB = Decimal("0.58")
# Wind at or above this is a meaningful push on run totals.
_STRONG_WIND_MPH = 12.0

MATCHUP_ANALYST_SYSTEM = (
    "You are the Matchup Analyst for an MLB/NPB prediction system. You review a "
    "completed prediction against qualitative context to catch things the "
    "statistical model does not capture. You do NOT recompute the model or invent "
    "probabilities.\n\n"
    "Consider: injuries (does a key hitter or the listed starter being out "
    "undercut the picked side?); pitcher trends; weather vs the total (wind out + "
    "warm push totals UP; wind in + cold push them DOWN); park and lineup "
    "context.\n\n"
    "For each concern give a severity and a SCREAMING_SNAKE_CASE code. Set "
    "suggestedMaxRank to the best rank the matchup context supports: 'B' when real "
    "qualitative risk exists, 'C' when the context seriously undermines the pick, "
    "otherwise 'none'."
)


def _picked_side(ctx: ReviewContext) -> str | None:
    """The moneyline side the model is picking, or None if it's a coin flip."""

    if (ctx.home_win_prob - ctx.away_win_prob).copy_abs() < Decimal("0.02"):
        return None
    return "home" if ctx.home_win_prob > ctx.away_win_prob else "away"


def _matchup_rules(ctx: ReviewContext) -> tuple[list[ReviewFlag], ReviewRank | None]:
    flags: list[ReviewFlag] = []
    cap: ReviewRank | None = None

    def flag(severity: Severity, code: str, message: str) -> None:
        nonlocal cap
        flags.append(ReviewFlag(agent=_AGENT, severity=severity, code=code, message=message))
        cap = merge_caps(cap, cap_for_severity(severity))

    # Key injury on the side we're picking.
    side = _picked_side(ctx)
    if side is not None:
        lean = ctx.home_win_prob if side == "home" else ctx.away_win_prob
        if lean >= _STRONG_LEAN_PROB:
            for injury in ctx.injuries:
                if injury.side == side and injury.key_player and injury.status != "day-to-day":
                    flag(
                        Severity.WARNING,
                        "KEY_INJURY_ON_PICK",
                        f"Pick leans {lean * 100:.0f}% on the {side} team, but key "
                        f"player {injury.player} is {injury.status}.",
                    )

    # Weather contradicting the total lean (only when we have a total line).
    weather = ctx.weather
    if (
        weather is not None
        and weather.wind_mph >= _STRONG_WIND_MPH
        and ctx.predicted_total is not None
        and ctx.total_line is not None
    ):
        leans_over = ctx.predicted_total > ctx.total_line
        if leans_over and weather.wind_dir == "in":
            flag(
                Severity.WARNING,
                "WEATHER_CONTRA_TOTAL",
                f"Total leans OVER but wind is blowing in at {weather.wind_mph:.0f} "
                "mph, which suppresses runs.",
            )
        elif not leans_over and weather.wind_dir == "out":
            flag(
                Severity.WARNING,
                "WEATHER_CONTRA_TOTAL",
                f"Total leans UNDER but wind is blowing out at {weather.wind_mph:.0f} "
                "mph, which inflates runs.",
            )

    return flags, cap


def review_matchup_analyst(
    ctx: ReviewContext, provider: ReviewProvider
) -> AgentVerdict:
    flags, cap = _matchup_rules(ctx)
    reasoning = ""
    source = VerdictSource.HEURISTIC

    if provider.available:
        outcome = provider.reason(
            ReasonRequest(system=MATCHUP_ANALYST_SYSTEM, context=serialize_context(ctx))
        )
        if outcome.ok and outcome.verdict is not None:
            flags.extend(llm_concerns_to_flags(_AGENT, outcome.verdict))
            cap = merge_caps(cap, outcome.verdict.suggested_max_rank)
            reasoning = outcome.verdict.overall_assessment
            source = VerdictSource.HEURISTIC_LLM
        else:
            reasoning = (
                f"LLM review unavailable ({outcome.note}); deterministic matchup checks only."
            )
    else:
        reasoning = (
            "Deterministic matchup checks only (no LLM provider); qualitative review skipped."
        )

    worst = worst_severity(flags)
    return AgentVerdict(
        agent=_AGENT,
        ok=worst is None or worst is Severity.INFO,
        flags=tuple(flags),
        suggested_max_rank=cap,
        reasoning=reasoning,
        source=source,
    )
