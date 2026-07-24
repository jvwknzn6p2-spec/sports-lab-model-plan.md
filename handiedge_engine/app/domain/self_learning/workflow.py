"""Self-Learning workflow state machine.

The engine never auto-retrains and deploys after every game. This module encodes
the controlled workflow: valid transitions, the safety gates that must pass at
each stage, and the champion/challenger approval requirement before deployment.
Heavy model training is delegated to an injected trainer adapter; the control
flow and gates here are fully functional.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.core.enums import LearningWorkflowStatus as S
from app.core.exceptions import InvalidWorkflowTransitionError

# Allowed forward transitions. REJECTED / FAILED are terminal sinks reachable
# from most working states.
_TRANSITIONS: dict[S, set[S]] = {
    S.PENDING_DATA: {S.DATA_VALIDATED, S.FAILED},
    S.DATA_VALIDATED: {S.LEAKAGE_CHECKED, S.FAILED},
    S.LEAKAGE_CHECKED: {S.READY_FOR_TRAINING, S.FAILED},
    S.READY_FOR_TRAINING: {S.TRAINING, S.FAILED},
    S.TRAINING: {S.BACKTESTING, S.FAILED},
    S.BACKTESTING: {S.OOS_VALIDATION, S.FAILED},
    S.OOS_VALIDATION: {S.CALIBRATION_VALIDATION, S.FAILED},
    S.CALIBRATION_VALIDATION: {S.CHALLENGER_READY, S.FAILED},
    S.CHALLENGER_READY: {S.APPROVAL_REQUIRED, S.FAILED},
    S.APPROVAL_REQUIRED: {S.APPROVED, S.REJECTED},
    S.APPROVED: {S.DEPLOYED, S.FAILED},
    S.DEPLOYED: set(),
    S.REJECTED: set(),
    S.FAILED: set(),
}

# The natural "next" stage for an advance without an explicit target.
_NEXT: dict[S, S] = {
    S.PENDING_DATA: S.DATA_VALIDATED,
    S.DATA_VALIDATED: S.LEAKAGE_CHECKED,
    S.LEAKAGE_CHECKED: S.READY_FOR_TRAINING,
    S.READY_FOR_TRAINING: S.TRAINING,
    S.TRAINING: S.BACKTESTING,
    S.BACKTESTING: S.OOS_VALIDATION,
    S.OOS_VALIDATION: S.CALIBRATION_VALIDATION,
    S.CALIBRATION_VALIDATION: S.CHALLENGER_READY,
    S.CHALLENGER_READY: S.APPROVAL_REQUIRED,
    S.APPROVAL_REQUIRED: S.APPROVED,
    S.APPROVED: S.DEPLOYED,
}

MIN_SAMPLE_SIZE = 200


@dataclass
class TransitionResult:
    new_status: S
    blockers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def can_transition(current: S, target: S) -> bool:
    return target in _TRANSITIONS.get(current, set())


def next_status(current: S) -> S | None:
    return _NEXT.get(current)


def advance(
    current: S,
    target: S | None,
    *,
    metrics: dict[str, float],
    context: dict[str, Any],
    approved_by: str | None = None,
) -> TransitionResult:
    """Validate and perform one workflow transition, enforcing stage gates."""

    desired = target or next_status(current)
    if desired is None:
        raise InvalidWorkflowTransitionError(
            f"workflow in terminal or unknown state {current.value}; cannot advance"
        )
    if not can_transition(current, desired):
        raise InvalidWorkflowTransitionError(
            f"invalid transition {current.value} -> {desired.value}",
            details={"allowed": sorted(s.value for s in _TRANSITIONS.get(current, set()))},
        )

    blockers = _gate_blockers(desired, metrics=metrics, context=context, approved_by=approved_by)
    if blockers:
        raise InvalidWorkflowTransitionError(
            f"gate for {desired.value} not satisfied",
            details={"blockers": blockers},
        )
    return TransitionResult(new_status=desired, notes=[f"advanced to {desired.value}"])


def _gate_blockers(
    target: S,
    *,
    metrics: dict[str, float],
    context: dict[str, Any],
    approved_by: str | None,
) -> list[str]:
    blockers: list[str] = []

    if target is S.DATA_VALIDATED:
        if not context.get("all_games_settled", False):
            blockers.append("training data contains unsettled games")
        if context.get("sample_size", 0) < MIN_SAMPLE_SIZE:
            blockers.append(
                f"sample size {context.get('sample_size', 0)} < min {MIN_SAMPLE_SIZE}"
            )

    if target is S.LEAKAGE_CHECKED:
        if context.get("future_leakage_detected", False):
            blockers.append("future-information leakage detected")
        if context.get("same_day_contamination", False):
            blockers.append("same-day result contamination into a locked prediction")

    if target is S.CHALLENGER_READY:
        # Require the full evaluation battery to be present.
        for key in ("brier", "log_loss", "calibration_error", "accuracy", "handicap_accuracy"):
            if key not in metrics:
                blockers.append(f"missing evaluation metric: {key}")

    if target is S.APPROVED:
        if not approved_by:
            blockers.append("production promotion requires explicit approver")
        # No automatic champion replacement based only on accuracy.
        challenger = metrics.get("challenger_brier")
        champion = metrics.get("champion_brier")
        if challenger is not None and champion is not None and challenger >= champion:
            blockers.append(
                "challenger does not improve Brier over champion; approval blocked"
            )

    if target is S.DEPLOYED and not context.get("approved", False):
        blockers.append("cannot deploy without prior approval")

    return blockers
