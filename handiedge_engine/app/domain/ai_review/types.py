"""Domain contracts for the AI multi-agent review layer (model-plan Step 9 / §4.5).

The review layer is the final "sanity check" before a prediction is locked and
published. It consumes the finished Decision-Engine output plus the Control
Tower context and produces an adjusted confidence tier and human-readable
warnings.

Design invariant from the plan (§4.5):

    "The AI review can lower confidence or add warnings, but the numbers still
     come from the statistical model + simulation. AI is the reviewer, not the
     source of truth."

Everything here is shaped around that invariant — the review never rewrites a
probability, it only annotates and (at most) downgrades the confidence tier.

This is a Python port of the TypeScript ``lib/ai-review`` package developed on
the ``step-9-ai-multi-agent-review`` branch, adapted to operate on HandiEdge's
own domain objects (Control Tower payload + Decision output) rather than the
standalone ``GamePrediction`` shape.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.core.enums import StrEnum


class ReviewRank(StrEnum):
    """Coarse confidence rank used by the review layer (best S -> worst C).

    HandiEdge's Decision Engine emits a fine 13-value :class:`ConfidenceTier`
    (S+ .. C- / NONE). The reviewers reason in the coarse S/A/B/C space of the
    model plan (§2); :mod:`app.domain.ai_review.confidence` maps between the two
    and guarantees the fine tier is only ever downgraded.
    """

    S = "S"
    A = "A"
    B = "B"
    C = "C"


class AgentRole(StrEnum):
    DATA_AUDITOR = "data-auditor"
    MATCHUP_ANALYST = "matchup-analyst"
    RISK_REVIEWER = "risk-reviewer"


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class VerdictSource(StrEnum):
    """Where a verdict came from — deterministic rules or the LLM reasoning pass."""

    HEURISTIC = "heuristic"
    LLM = "llm"
    HEURISTIC_LLM = "heuristic+llm"


@dataclass(frozen=True)
class ReviewFlag:
    """A single issue raised by a reviewer."""

    agent: AgentRole
    severity: Severity
    code: str  # machine-readable, SCREAMING_SNAKE_CASE, e.g. "UNCONFIRMED_STARTER"
    message: str


@dataclass(frozen=True)
class AgentVerdict:
    """One agent's complete assessment of a prediction."""

    agent: AgentRole
    ok: bool
    flags: tuple[ReviewFlag, ...]
    # The best (highest) rank this agent believes the pick may hold. ``None``
    # means "no opinion / no cap". The orchestrator caps the final rank at the
    # most conservative suggestion across all agents.
    suggested_max_rank: ReviewRank | None
    reasoning: str
    source: VerdictSource


@dataclass(frozen=True)
class ReviewResult:
    """The aggregated result of running all agents over one prediction."""

    match_id: str
    prediction_id: str | None
    original_rank: ReviewRank
    final_rank: ReviewRank
    downgraded: bool
    verdicts: tuple[AgentVerdict, ...]
    flags: tuple[ReviewFlag, ...]
    warnings: tuple[str, ...]
    reviewed_at: str  # ISO-8601


# --------------------------------------------------------------------------- #
# Normalized review input (the agent-facing view of a HandiEdge prediction)
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class StarterView:
    name: str
    confirmed: bool


@dataclass(frozen=True)
class WeatherView:
    wind_mph: float
    # Relative to the field: "out" boosts run totals, "in" suppresses them.
    wind_dir: str  # "in" | "out" | "cross" | "calm" | "unknown"
    temp_f: float | None


@dataclass(frozen=True)
class InjuryView:
    player: str
    side: str  # "home" | "away"
    status: str  # "out" | "questionable" | "day-to-day"
    key_player: bool


@dataclass(frozen=True)
class ReviewContext:
    """A faithful, normalized snapshot of one game's finished prediction.

    Built by :mod:`app.domain.ai_review.context` from the Control Tower game,
    the run payload, the raw prediction, and the Decision-Engine output. The
    agents read *this* — never the raw HandiEdge schemas — so the reviewers stay
    decoupled from upstream schema churn (mirrors the TS ``serializePrediction``).
    """

    match_id: str
    prediction_id: str | None
    home: str
    away: str

    # --- data-quality snapshot (what the Data Auditor inspects) ---
    schedule_confirmed: bool
    home_starter: StarterView | None
    away_starter: StarterView | None
    batting_stats_available: bool
    bullpen_stats_available: bool
    recent_form_available: bool
    park_factors_available: bool
    odds_available: bool
    weather: WeatherView | None
    injuries: tuple[InjuryView, ...]
    staleness_minutes: int | None

    # --- model outputs (what the Risk Reviewer / Matchup Analyst weigh) ---
    home_win_prob: Decimal
    away_win_prob: Decimal
    component_agreement: Decimal | None
    market_edge: Decimal | None
    predicted_total: Decimal | None
    total_line: Decimal | None

    # --- decision context ---
    original_tier_rank: ReviewRank
    is_predict: bool
    key_factors: tuple[str, ...] = field(default_factory=tuple)
