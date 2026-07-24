"""Error Analysis Engine.

Produces structured post-settlement analysis. It strictly separates observed
facts, derived metrics, and hypotheses (each with an explicit confidence). When
evidence is insufficient it does NOT assert a causal reason — the primary
category falls back to UNKNOWN.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.core.enums import ErrorCategory, PredictionResult
from app.domain.settlement.engine import SettlementOutcome
from app.schemas.error_analysis import Hypothesis


@dataclass
class ErrorAnalysis:
    prediction_error: Decimal | None
    brier_contribution: Decimal | None
    log_loss_contribution: Decimal | None
    calibration_bucket: str | None
    expected_margin_error: Decimal | None
    actual_margin: int | None
    primary_error_category: ErrorCategory
    secondary_error_categories: list[ErrorCategory]
    observed_evidence: list[str]
    derived_metrics: dict[str, float]
    hypotheses: list[Hypothesis]
    recommended_follow_up: list[str]
    retraining_eligibility: bool = field(default=False)


def analyze(
    prediction_ctx: dict[str, Any],
    outcome: SettlementOutcome,
    post_lock_events: list[dict[str, Any]] | None = None,
) -> ErrorAnalysis:
    post_lock_events = post_lock_events or []
    observed: list[str] = []
    derived: dict[str, float] = {}
    hypotheses: list[Hypothesis] = []
    secondary: list[ErrorCategory] = []
    follow_up: list[str] = []

    # Void / not-settled games carry no error signal.
    if outcome.normal_result in (PredictionResult.VOID, PredictionResult.NOT_SETTLED):
        observed.append(f"settlement not scored: {outcome.normal_result.value}")
        return ErrorAnalysis(
            prediction_error=None,
            brier_contribution=None,
            log_loss_contribution=None,
            calibration_bucket=None,
            expected_margin_error=None,
            actual_margin=None,
            primary_error_category=ErrorCategory.UNKNOWN,
            secondary_error_categories=[],
            observed_evidence=observed,
            derived_metrics=derived,
            hypotheses=[],
            recommended_follow_up=["await a scored settlement before error analysis"],
            retraining_eligibility=False,
        )

    selected = prediction_ctx.get("selected_team")
    win_p = prediction_ctx.get("normal_win_probability")
    p = float(win_p) if win_p is not None else None
    won = outcome.normal_result is PredictionResult.WIN
    y = 1.0 if won else 0.0

    prediction_error = brier = log_loss = None
    bucket = None
    if p is not None:
        p_clamped = min(max(p, 1e-6), 1 - 1e-6)
        prediction_error = Decimal(str(round(abs(p - y), 6)))
        brier = Decimal(str(round((p - y) ** 2, 6)))
        log_loss = Decimal(
            str(round(-(y * math.log(p_clamped) + (1 - y) * math.log(1 - p_clamped)), 6))
        )
        low = int(p * 10) * 10
        bucket = f"{low}-{low + 10}%"
        derived["predicted_win_probability"] = round(p, 6)
        derived["brier"] = float(brier)
        derived["log_loss"] = float(log_loss)
        observed.append(
            f"selected={selected} predicted_win_prob={p:.4f} actual={'WIN' if won else 'LOSS'}"
        )

    # Actual margin (from the selected team's perspective).
    actual_margin = None
    expected_margin_error = None
    if outcome.score_home is not None and outcome.score_away is not None and selected:
        home = prediction_ctx.get("home")
        selected_is_home = str(selected).strip().lower() == str(home).strip().lower()
        home_margin = outcome.score_home - outcome.score_away
        actual_margin = home_margin if selected_is_home else -home_margin
        observed.append(
            f"final_score home={outcome.score_home} away={outcome.score_away} "
            f"selected_margin={actual_margin}"
        )
        exp_home = prediction_ctx.get("expected_score_home")
        exp_away = prediction_ctx.get("expected_score_away")
        if exp_home is not None and exp_away is not None:
            exp_home_margin = float(exp_home) - float(exp_away)
            exp_selected_margin = exp_home_margin if selected_is_home else -exp_home_margin
            expected_margin_error = Decimal(
                str(round(abs(exp_selected_margin - actual_margin), 4))
            )
            derived["expected_margin"] = round(exp_selected_margin, 4)
            derived["expected_margin_error"] = float(expected_margin_error)

    # --- Hypothesis generation from evidence (never asserted as fact). --------
    primary = ErrorCategory.UNKNOWN
    if not won:
        risk_factors = prediction_ctx.get("risk_factors") or []
        event_types = {str(e.get("type", "")).upper() for e in post_lock_events}

        if "STARTER_SCRATCH" in event_types or any("starter" in r for r in risk_factors):
            hypotheses.append(
                Hypothesis(
                    statement="A starter change may have degraded the prediction.",
                    confidence=Decimal("0.5"),
                    supporting_evidence=["post-lock starter event or starter risk flag"],
                )
            )
            secondary.append(ErrorCategory.STARTER_CHANGE)
            primary = ErrorCategory.STARTER_CHANGE

        if any("stale" in r for r in risk_factors):
            hypotheses.append(
                Hypothesis(
                    statement="Stale input data may have reduced accuracy.",
                    confidence=Decimal("0.4"),
                    supporting_evidence=["data staleness risk flag present"],
                )
            )
            secondary.append(ErrorCategory.DATA_STALENESS)
            if primary is ErrorCategory.UNKNOWN:
                primary = ErrorCategory.DATA_STALENESS

        if actual_margin is not None and abs(actual_margin) >= 6:
            hypotheses.append(
                Hypothesis(
                    statement="A high-variance blowout drove the miss.",
                    confidence=Decimal("0.35"),
                    supporting_evidence=[f"actual_margin={actual_margin}"],
                )
            )
            secondary.append(ErrorCategory.HIGH_VARIANCE_EVENT)

        if p is not None and p >= 0.6 and not won:
            hypotheses.append(
                Hypothesis(
                    statement="Confident pick lost; possible calibration or model misread.",
                    confidence=Decimal("0.3"),
                    supporting_evidence=[f"predicted_win_prob={p:.3f} but LOSS"],
                )
            )
            if primary is ErrorCategory.UNKNOWN:
                primary = ErrorCategory.MODEL_MISREAD
            follow_up.append("review calibration bucket hit-rate for this probability band")

    else:
        observed.append("prediction correct; no error category assigned")

    if outcome.handicap_result in (PredictionResult.PARTIAL_LOSS, PredictionResult.LOSS):
        secondary.append(ErrorCategory.HANDICAP_MARGIN_ERROR)

    # De-duplicate secondaries and drop the primary from the secondary list.
    seen: set[ErrorCategory] = set()
    dedup_secondary = []
    for c in secondary:
        if c != primary and c not in seen:
            dedup_secondary.append(c)
            seen.add(c)

    retraining = bool(win_p is not None and outcome.normal_result in (
        PredictionResult.WIN,
        PredictionResult.LOSS,
    ))

    return ErrorAnalysis(
        prediction_error=prediction_error,
        brier_contribution=brier,
        log_loss_contribution=log_loss,
        calibration_bucket=bucket,
        expected_margin_error=expected_margin_error,
        actual_margin=actual_margin,
        primary_error_category=primary,
        secondary_error_categories=dedup_secondary,
        observed_evidence=observed,
        derived_metrics=derived,
        hypotheses=hypotheses,
        recommended_follow_up=follow_up,
        retraining_eligibility=retraining,
    )
