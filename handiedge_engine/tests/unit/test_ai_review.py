"""Unit tests for the AI multi-agent review layer (Step 9).

Covers the deterministic confidence math (the AI-only-downgrades invariant), the
three agents' guardrail passes, the orchestrator aggregation, and the HandiEdge
context adapter. All offline — no LLM provider required.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.core.enums import ConfidenceTier
from app.domain.ai_review.agents.data_auditor import review_data_auditor
from app.domain.ai_review.agents.matchup_analyst import review_matchup_analyst
from app.domain.ai_review.agents.risk_reviewer import review_risk_reviewer
from app.domain.ai_review.confidence import (
    TIER_ORDER,
    apply_review_to_tier,
    cap_at,
    coarse_of_tier,
    downgrade,
    min_rank,
    rank_index,
    tier_index,
)
from app.domain.ai_review.orchestrator import review_prediction
from app.domain.ai_review.provider import HeuristicReviewProvider
from app.domain.ai_review.types import (
    InjuryView,
    ReviewContext,
    ReviewRank,
    StarterView,
    WeatherView,
)

PROVIDER = HeuristicReviewProvider()


def _ctx(**overrides) -> ReviewContext:
    """A clean, fully-populated review context; override fields per test."""

    base = dict(
        match_id="M1",
        prediction_id="pid-1",
        home="NYY",
        away="BOS",
        schedule_confirmed=True,
        home_starter=StarterView(name="Cole", confirmed=True),
        away_starter=StarterView(name="Bello", confirmed=True),
        batting_stats_available=True,
        bullpen_stats_available=True,
        recent_form_available=True,
        park_factors_available=True,
        odds_available=True,
        weather=WeatherView(wind_mph=6.0, wind_dir="calm", temp_f=78.0),
        injuries=(),
        staleness_minutes=30,
        home_win_prob=Decimal("0.64"),
        away_win_prob=Decimal("0.36"),
        component_agreement=Decimal("0.8"),
        market_edge=Decimal("0.05"),
        predicted_total=Decimal("8.4"),
        total_line=Decimal("8.5"),
        original_tier_rank=ReviewRank.A,
        is_predict=True,
        key_factors=(),
    )
    base.update(overrides)
    return ReviewContext(**base)


# --------------------------------------------------------------------------- #
# Confidence math
# --------------------------------------------------------------------------- #


def test_rank_order_and_min_rank():
    assert rank_index(ReviewRank.S) < rank_index(ReviewRank.C)
    assert min_rank(ReviewRank.A, ReviewRank.C) is ReviewRank.C
    assert min_rank(ReviewRank.B, ReviewRank.S) is ReviewRank.B


def test_downgrade_and_cap_never_upgrade():
    assert downgrade(ReviewRank.S, 2) is ReviewRank.B
    assert downgrade(ReviewRank.C, 5) is ReviewRank.C  # clamped
    assert downgrade(ReviewRank.A, -3) is ReviewRank.A  # negative -> no-op
    assert cap_at(ReviewRank.S, ReviewRank.B) is ReviewRank.B
    assert cap_at(ReviewRank.C, ReviewRank.A) is ReviewRank.C  # cap can't raise


def test_coarse_of_tier_maps_families():
    assert coarse_of_tier(ConfidenceTier.S_PLUS) is ReviewRank.S
    assert coarse_of_tier(ConfidenceTier.A_MINUS) is ReviewRank.A
    assert coarse_of_tier(ConfidenceTier.B) is ReviewRank.B
    assert coarse_of_tier(ConfidenceTier.C_MINUS) is ReviewRank.C
    assert coarse_of_tier(ConfidenceTier.NONE) is ReviewRank.C


@pytest.mark.parametrize("tier", list(TIER_ORDER))
@pytest.mark.parametrize("rank", list(ReviewRank))
def test_apply_review_to_tier_never_raises(tier, rank):
    result = apply_review_to_tier(tier, rank)
    assert tier_index(result) >= tier_index(tier)  # equal or worse, never better


def test_apply_review_to_tier_downgrades_across_family():
    # A+ capped at coarse B -> best B tier (B+), a genuine downgrade.
    assert apply_review_to_tier(ConfidenceTier.A_PLUS, ReviewRank.B) is ConfidenceTier.B_PLUS
    # B- capped at B is a no-op (already at/below B+).
    assert apply_review_to_tier(ConfidenceTier.B_MINUS, ReviewRank.B) is ConfidenceTier.B_MINUS


# --------------------------------------------------------------------------- #
# Data Auditor
# --------------------------------------------------------------------------- #


def test_data_auditor_clean_is_ok():
    v = review_data_auditor(_ctx(), PROVIDER)
    assert v.ok is True
    assert v.suggested_max_rank is None
    assert v.flags == ()


def test_data_auditor_unconfirmed_starter_is_critical_caps_c():
    v = review_data_auditor(
        _ctx(home_starter=StarterView(name="Cole", confirmed=False)), PROVIDER
    )
    codes = {f.code for f in v.flags}
    assert "UNCONFIRMED_STARTER" in codes
    assert v.suggested_max_rank is ReviewRank.C
    assert v.ok is False


def test_data_auditor_missing_odds_and_batting():
    v = review_data_auditor(
        _ctx(odds_available=False, batting_stats_available=False), PROVIDER
    )
    codes = {f.code for f in v.flags}
    assert "MISSING_ODDS" in codes  # critical
    assert "MISSING_BATTING" in codes  # warning
    assert v.suggested_max_rank is ReviewRank.C  # critical dominates


def test_data_auditor_prob_sum_invalid():
    v = review_data_auditor(
        _ctx(home_win_prob=Decimal("0.7"), away_win_prob=Decimal("0.7")), PROVIDER
    )
    assert any(f.code == "PROB_SUM_INVALID" for f in v.flags)


# --------------------------------------------------------------------------- #
# Matchup Analyst
# --------------------------------------------------------------------------- #


def test_matchup_key_injury_on_picked_side():
    v = review_matchup_analyst(
        _ctx(
            home_win_prob=Decimal("0.62"),
            away_win_prob=Decimal("0.38"),
            injuries=(
                InjuryView(player="Judge", side="home", status="out", key_player=True),
            ),
        ),
        PROVIDER,
    )
    assert any(f.code == "KEY_INJURY_ON_PICK" for f in v.flags)
    assert v.suggested_max_rank is ReviewRank.B


def test_matchup_weather_contradicts_total():
    # Total leans UNDER (predicted < line) but wind blows out hard -> contradiction.
    v = review_matchup_analyst(
        _ctx(
            predicted_total=Decimal("7.0"),
            total_line=Decimal("8.5"),
            weather=WeatherView(wind_mph=15.0, wind_dir="out", temp_f=85.0),
        ),
        PROVIDER,
    )
    assert any(f.code == "WEATHER_CONTRA_TOTAL" for f in v.flags)


def test_matchup_clean_no_flags():
    v = review_matchup_analyst(_ctx(), PROVIDER)
    assert v.flags == ()


# --------------------------------------------------------------------------- #
# Risk Reviewer
# --------------------------------------------------------------------------- #


def test_risk_low_component_agreement_on_high_rank():
    v = review_risk_reviewer(
        _ctx(original_tier_rank=ReviewRank.S, component_agreement=Decimal("0.4")),
        PROVIDER,
    )
    assert any(f.code == "LOW_COMPONENT_AGREEMENT" for f in v.flags)
    assert v.suggested_max_rank is ReviewRank.B


def test_risk_coin_flip_caps_c():
    v = review_risk_reviewer(
        _ctx(home_win_prob=Decimal("0.51"), away_win_prob=Decimal("0.49")),
        PROVIDER,
    )
    assert any(f.code == "COIN_FLIP" for f in v.flags)
    assert v.suggested_max_rank is ReviewRank.C


def test_risk_thin_edge_on_high_rank():
    v = review_risk_reviewer(
        _ctx(original_tier_rank=ReviewRank.A, market_edge=Decimal("0.01")),
        PROVIDER,
    )
    assert any(f.code == "THIN_EDGE" for f in v.flags)


# --------------------------------------------------------------------------- #
# Orchestrator
# --------------------------------------------------------------------------- #


def test_orchestrator_clean_upholds_rank():
    result = review_prediction(_ctx(original_tier_rank=ReviewRank.A), PROVIDER, "t0")
    assert result.final_rank is ReviewRank.A
    assert result.downgraded is False
    assert result.warnings == ()
    assert len(result.verdicts) == 3


def test_orchestrator_downgrades_and_warns_on_critical():
    result = review_prediction(
        _ctx(
            original_tier_rank=ReviewRank.S,
            home_starter=StarterView(name="Cole", confirmed=False),
            odds_available=False,
        ),
        PROVIDER,
        "t0",
    )
    assert result.final_rank is ReviewRank.C
    assert result.downgraded is True
    assert result.warnings[0].startswith("Confidence downgraded")
    # Critical flags sort ahead of warnings.
    assert result.flags[0].severity.value == "critical"


def test_orchestrator_review_only_downgrades_never_raises():
    # Start from the worst rank; no agent can push it back up.
    result = review_prediction(_ctx(original_tier_rank=ReviewRank.C), PROVIDER, "t0")
    assert result.final_rank is ReviewRank.C
    assert result.downgraded is False
