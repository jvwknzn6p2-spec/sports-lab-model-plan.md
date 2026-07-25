"""Shared building blocks for the three review agents.

Each agent follows the same shape:
  1. a deterministic rule pass (guardrails that always run), and
  2. an optional LLM reasoning pass (qualitative judgment).
This module holds the pieces both passes need: severity -> cap policy, verdict
assembly, and context serialization.
"""

from __future__ import annotations

import json

from app.domain.ai_review.confidence import min_rank
from app.domain.ai_review.provider import LlmVerdict
from app.domain.ai_review.types import (
    AgentRole,
    ReviewContext,
    ReviewFlag,
    ReviewRank,
    Severity,
)

_SEVERITY_WEIGHT: dict[Severity, int] = {
    Severity.INFO: 0,
    Severity.WARNING: 1,
    Severity.CRITICAL: 2,
}


def worst_severity(flags: list[ReviewFlag]) -> Severity | None:
    worst: Severity | None = None
    for flag in flags:
        if worst is None or _SEVERITY_WEIGHT[flag.severity] > _SEVERITY_WEIGHT[worst]:
            worst = flag.severity
    return worst


def cap_for_severity(severity: Severity | None) -> ReviewRank | None:
    """Default cap policy shared by the deterministic passes.

    A critical issue caps the pick at C (informational only); a warning caps it
    at B (no open-warning pick may be a headline S/A). Info-only findings impose
    no cap. Agents may override per-flag when a finding warrants a different one.
    """

    if severity is Severity.CRITICAL:
        return ReviewRank.C
    if severity is Severity.WARNING:
        return ReviewRank.B
    return None


def merge_caps(a: ReviewRank | None, b: ReviewRank | None) -> ReviewRank | None:
    """Combine two optional caps into the more conservative one."""

    if a is None:
        return b
    if b is None:
        return a
    return min_rank(a, b)


def llm_concerns_to_flags(agent: AgentRole, verdict: LlmVerdict) -> list[ReviewFlag]:
    """Tag each bare LLM concern with its owning agent to form a ReviewFlag."""

    return [
        ReviewFlag(agent=agent, severity=c.severity, code=c.code, message=c.message)
        for c in verdict.concerns
    ]


def serialize_context(ctx: ReviewContext) -> str:
    """Serialize a review context into a compact, faithful text block for the
    model. Keys are emitted in a fixed order so structurally identical games
    serialize consistently. The full view is included — reviewers decide what is
    relevant, we do not pre-filter."""

    def _starter(s) -> dict | None:
        return None if s is None else {"name": s.name, "confirmed": s.confirmed}

    view = {
        "matchId": ctx.match_id,
        "matchup": f"{ctx.away} @ {ctx.home}",
        "preReviewRank": ctx.original_tier_rank.value,
        "decisionIsPredict": ctx.is_predict,
        "data": {
            "scheduleConfirmed": ctx.schedule_confirmed,
            "homeStarter": _starter(ctx.home_starter),
            "awayStarter": _starter(ctx.away_starter),
            "battingStatsAvailable": ctx.batting_stats_available,
            "bullpenStatsAvailable": ctx.bullpen_stats_available,
            "recentFormAvailable": ctx.recent_form_available,
            "parkFactorsAvailable": ctx.park_factors_available,
            "oddsAvailable": ctx.odds_available,
            "weather": (
                None
                if ctx.weather is None
                else {
                    "windMph": ctx.weather.wind_mph,
                    "windDir": ctx.weather.wind_dir,
                    "tempF": ctx.weather.temp_f,
                }
            ),
            "injuries": [
                {
                    "player": i.player,
                    "side": i.side,
                    "status": i.status,
                    "keyPlayer": i.key_player,
                }
                for i in ctx.injuries
            ],
            "stalenessMinutes": ctx.staleness_minutes,
        },
        "model": {
            "homeWinProb": float(ctx.home_win_prob),
            "awayWinProb": float(ctx.away_win_prob),
            "componentAgreement": (
                None if ctx.component_agreement is None else float(ctx.component_agreement)
            ),
            "marketEdge": None if ctx.market_edge is None else float(ctx.market_edge),
            "predictedTotal": (
                None if ctx.predicted_total is None else float(ctx.predicted_total)
            ),
            "totalLine": None if ctx.total_line is None else float(ctx.total_line),
        },
        "keyFactors": list(ctx.key_factors),
    }
    return json.dumps(view, indent=2, ensure_ascii=False)
