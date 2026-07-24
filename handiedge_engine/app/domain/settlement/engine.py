"""Settlement Engine.

Deterministic, rerunnable settlement with league/scope-specific score selection
and handicap-specific rules (via the handicap rule registry). Pure settlement
logic lives here; persistence, idempotency, and conflict detection live in the
settlement service.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.enums import (
    GameStatus,
    PredictionResult,
    SettlementScope,
    SettlementStatus,
)
from app.domain.handicap.parser import parse_handicap
from app.domain.settlement.handicap_rules import (
    HandicapOutcome,
    HandicapResolutionError,
    settle_favorite_margin,
)
from app.schemas.settlement import Score, SettlementInput


@dataclass(frozen=True)
class SettlementOutcome:
    settlement_status: SettlementStatus
    normal_result: PredictionResult
    handicap_result: PredictionResult
    winning_team: str | None
    losing_team: str | None
    score_home: int | None
    score_away: int | None
    push: bool
    partial_win: bool
    partial_loss: bool
    void_reason: str | None


# Statuses that void a settlement (no action / no result).
_VOID_STATUSES = {
    GameStatus.POSTPONED: "game postponed",
    GameStatus.CANCELLED: "game cancelled",
    GameStatus.NO_CONTEST: "no contest",
    GameStatus.SUSPENDED: "game suspended",
    GameStatus.IN_PROGRESS: "game in progress",
}

_HANDICAP_OUTCOME_TO_RESULT = {
    HandicapOutcome.WIN: PredictionResult.WIN,
    HandicapOutcome.LOSS: PredictionResult.LOSS,
    HandicapOutcome.PUSH: PredictionResult.PUSH,
    HandicapOutcome.PARTIAL_WIN: PredictionResult.PARTIAL_WIN,
    HandicapOutcome.PARTIAL_LOSS: PredictionResult.PARTIAL_LOSS,
}


def _score_for_scope(scope: SettlementScope, si: SettlementInput) -> Score | None:
    """Select the officially-relevant score for the settlement scope.

    MLB settles on the final score *including extra innings*; NPB settles on the
    *regulation nine innings* score only. Scopes are never substituted.
    """

    if scope is SettlementScope.MLB_FINAL_INCL_EXTRA:
        return si.final_score or si.regulation_score
    if scope is SettlementScope.NPB_REG9_ONLY:
        # Regulation-nine only: require the regulation score explicitly; do not
        # fall back to a final score that may include extra innings.
        return si.regulation_score
    raise ValueError(f"unsupported settlement scope: {scope}")


def settle(
    scope: SettlementScope,
    selected_team: str | None,
    home: str,
    away: str,
    handicap_raw: str | None,
    favorite: str | None,
    receiver: str | None,
    si: SettlementInput,
) -> SettlementOutcome:
    # 1) Void statuses.
    if si.game_status in _VOID_STATUSES:
        return SettlementOutcome(
            settlement_status=SettlementStatus.VOID,
            normal_result=PredictionResult.VOID,
            handicap_result=PredictionResult.VOID,
            winning_team=None,
            losing_team=None,
            score_home=None,
            score_away=None,
            push=False,
            partial_win=False,
            partial_loss=False,
            void_reason=_VOID_STATUSES[si.game_status],
        )

    score = _score_for_scope(scope, si)
    if score is None:
        return SettlementOutcome(
            settlement_status=SettlementStatus.VOID,
            normal_result=PredictionResult.VOID,
            handicap_result=PredictionResult.VOID,
            winning_team=None,
            losing_team=None,
            score_home=None,
            score_away=None,
            push=False,
            partial_win=False,
            partial_loss=False,
            void_reason=f"required score for scope {scope.value} not provided",
        )

    home_margin = score.home - score.away

    # 2) Normal winner. NPB regulation nine can end in a tie -> PUSH/void winner.
    if home_margin > 0:
        winner, loser = home, away
    elif home_margin < 0:
        winner, loser = away, home
    else:
        winner, loser = None, None

    if winner is None:
        normal_result = PredictionResult.PUSH  # regulation tie (NPB)
    elif selected_team is None:
        normal_result = PredictionResult.NOT_SETTLED
    elif selected_team.strip().lower() == winner.strip().lower():
        normal_result = PredictionResult.WIN
    else:
        normal_result = PredictionResult.LOSS

    # 3) Handicap result (independent). Re-parse deterministically from raw.
    handicap_result, push, partial_win, partial_loss = _settle_handicap(
        handicap_raw, favorite, receiver, home, away, home_margin
    )

    return SettlementOutcome(
        settlement_status=SettlementStatus.SETTLED,
        normal_result=normal_result,
        handicap_result=handicap_result,
        winning_team=winner,
        losing_team=loser,
        score_home=score.home,
        score_away=score.away,
        push=push,
        partial_win=partial_win,
        partial_loss=partial_loss,
        void_reason=None,
    )


def _settle_handicap(
    handicap_raw: str | None,
    favorite: str | None,
    receiver: str | None,
    home: str,
    away: str,
    home_margin: int,
) -> tuple[PredictionResult, bool, bool, bool]:
    if not handicap_raw or not favorite:
        return PredictionResult.NOT_SETTLED, False, False, False

    handicap = parse_handicap(handicap_raw, favorite=favorite, receiver=receiver)
    if not handicap.is_resolved:
        return PredictionResult.NOT_SETTLED, False, False, False

    favorite_is_home = favorite.strip().lower() == home.strip().lower()
    favorite_margin = home_margin if favorite_is_home else -home_margin
    try:
        outcome = settle_favorite_margin(handicap, favorite_margin)
    except HandicapResolutionError:
        return PredictionResult.NOT_SETTLED, False, False, False

    result = _HANDICAP_OUTCOME_TO_RESULT[outcome]
    return (
        result,
        outcome is HandicapOutcome.PUSH,
        outcome is HandicapOutcome.PARTIAL_WIN,
        outcome is HandicapOutcome.PARTIAL_LOSS,
    )
