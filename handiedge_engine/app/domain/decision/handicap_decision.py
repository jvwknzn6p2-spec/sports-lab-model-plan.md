"""Handicap decision — evaluated independently from the normal win prediction.

Cover probability is derived from a legitimate margin distribution, NEVER copied
from the normal win probability. When no distribution or numeric line exists, the
handicap decision returns PASS/UNAVAILABLE and does not manufacture a percentage.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.config import DecisionThresholds
from app.core.enums import HandicapDecisionStatus, HandicapRuleStatus, HandicapSide
from app.domain.settlement.handicap_rules import (
    HandicapOutcome,
    HandicapResolutionError,
    settle_favorite_margin,
)
from app.schemas.control_tower import ControlTowerGame
from app.schemas.decision import HandicapDecision
from app.schemas.handicap import Handicap
from app.schemas.prediction import RawGamePrediction

_TOL = Decimal("0.0005")


def evaluate_handicap(
    game: ControlTowerGame,
    handicap: Handicap,
    raw: RawGamePrediction,
    thresholds: DecisionThresholds,
) -> HandicapDecision:
    # 1) Unresolved handicap notation -> block, never guess.
    if handicap.rule_status is HandicapRuleStatus.UNRESOLVED:
        return HandicapDecision(
            handicap_rule_status=HandicapRuleStatus.UNRESOLVED.value,
            handicap_decision_status=HandicapDecisionStatus.BLOCKED,
            handicap_pass_reason="handicap notation UNRESOLVED; cannot lock handicap.",
        )

    # 2) Need a favorite to orient the line, and a margin distribution.
    favorite = handicap.favorite or game.favorite
    if not favorite:
        return HandicapDecision(
            handicap_rule_status=HandicapRuleStatus.RESOLVED.value,
            handicap_decision_status=HandicapDecisionStatus.PASS,
            handicap_pass_reason="no favorite designated; cannot orient handicap line.",
        )
    if raw.raw_margin_distribution is None:
        return HandicapDecision(
            handicap_rule_status=HandicapRuleStatus.RESOLVED.value,
            handicap_decision_status=HandicapDecisionStatus.UNAVAILABLE,
            handicap_pass_reason="no margin distribution available; cover probability unavailable.",
        )

    favorite_is_home = favorite.strip().lower() == game.home.strip().lower()

    # 3) Convolve the settlement rule over the (home) margin distribution.
    tallies: dict[HandicapOutcome, Decimal] = {o: Decimal("0") for o in HandicapOutcome}
    try:
        for home_margin_str, prob in raw.raw_margin_distribution.items():
            home_margin = int(home_margin_str)
            favorite_margin = home_margin if favorite_is_home else -home_margin
            outcome = settle_favorite_margin(handicap, favorite_margin)
            tallies[outcome] += Decimal(prob)
    except HandicapResolutionError as exc:
        return HandicapDecision(
            handicap_rule_status=HandicapRuleStatus.UNRESOLVED.value,
            handicap_decision_status=HandicapDecisionStatus.BLOCKED,
            handicap_pass_reason=f"handicap rule could not be resolved: {exc}",
        )

    total = sum(tallies.values())
    if (total - Decimal("1")).copy_abs() > Decimal("0.01"):
        return HandicapDecision(
            handicap_rule_status=HandicapRuleStatus.RESOLVED.value,
            handicap_decision_status=HandicapDecisionStatus.UNAVAILABLE,
            handicap_pass_reason="margin distribution does not sum to 1; cover unavailable.",
        )

    fav_full = tallies[HandicapOutcome.WIN]
    fav_partial_win = tallies[HandicapOutcome.PARTIAL_WIN]
    fav_partial_loss = tallies[HandicapOutcome.PARTIAL_LOSS]
    push = tallies[HandicapOutcome.PUSH]
    fav_loss = tallies[HandicapOutcome.LOSS]

    # Expected cover value for each side (partial counts half).
    fav_ev = fav_full + fav_partial_win / 2 - fav_partial_loss / 2 - fav_loss
    receiver = handicap.receiver or game.receiver or (
        game.away if favorite_is_home else game.home
    )

    if fav_ev >= 0:
        side, pick = HandicapSide.FAVORITE, favorite
        cover = fav_full
        p_win, p_loss = fav_partial_win, fav_partial_loss
    else:
        # Receiver perspective mirrors the favorite outcomes.
        side, pick = HandicapSide.RECEIVER, receiver
        cover = fav_loss
        p_win, p_loss = fav_partial_loss, fav_partial_win

    status = HandicapDecisionStatus.PREDICT
    reason: str | None = None
    if cover < thresholds.min_handicap_cover_probability:
        status = HandicapDecisionStatus.PASS
        reason = (
            f"cover probability {cover} below minimum "
            f"{thresholds.min_handicap_cover_probability}."
        )

    return HandicapDecision(
        handicap_pick=pick,
        handicap_side=side,
        handicap_cover_probability=_q(cover),
        handicap_push_probability=_q(push),
        handicap_partial_win_probability=_q(p_win),
        handicap_partial_loss_probability=_q(p_loss),
        handicap_rule_status=HandicapRuleStatus.RESOLVED.value,
        handicap_decision_status=status,
        handicap_pass_reason=reason,
    )


def _q(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.0001"))
