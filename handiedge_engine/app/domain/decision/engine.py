"""Decision Engine.

Converts calibrated model output into an operational decision. It does NOT simply
select the higher probability — it evaluates evidence quality, freshness, starter
and schedule confirmation, model/market disagreement, risk flags, and handicap
certainty against typed, configurable gates. When gates fail it returns
PASS/BLOCKED/INVALID rather than forcing a prediction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from app.core.clock import to_utc
from app.core.config import DecisionThresholds
from app.core.enums import (
    ConfidenceTier,
    DataQualityStatus,
    DecisionStatus,
    HandicapDecisionStatus,
    League,
    RiskLevel,
    ValidationStatus,
)
from app.domain.decision.calibration import CalibrationResult
from app.domain.decision.confidence import tier_for_probability
from app.domain.decision.handicap_decision import evaluate_handicap
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.decision import GameDecision, HandicapDecision
from app.schemas.handicap import Handicap
from app.schemas.prediction import RawGamePrediction


@dataclass
class _Signals:
    calibrated_home: Decimal
    calibrated_away: Decimal
    evidence_completeness: Decimal
    staleness_minutes: int | None
    starter_confirmed: bool
    schedule_validated: bool
    model_disagreement: Decimal | None
    market_disagreement: Decimal | None
    critical_risk_count: int
    supporting: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)


class DecisionEngine:
    def __init__(self, thresholds: DecisionThresholds) -> None:
        self._t = thresholds

    def decide(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        calib_home: CalibrationResult,
        calib_away: CalibrationResult,
        handicap: Handicap,
    ) -> GameDecision:
        signals = self._gather_signals(game, payload, raw, calib_home, calib_away)

        # Pick the higher calibrated side as the candidate winner.
        if signals.calibrated_home >= signals.calibrated_away:
            selected, loser = game.home, game.away
            win_p, loss_p = signals.calibrated_home, signals.calibrated_away
        else:
            selected, loser = game.away, game.home
            win_p, loss_p = signals.calibrated_away, signals.calibrated_home

        calibration_notes = [calib_home.warning or "", calib_away.warning or ""]
        calibration_notes = [n for n in calibration_notes if n]
        if calib_home.clipped or calib_away.clipped:
            calibration_notes.append(
                "Probability clipped to safe bounds "
                f"[{self._t.probability_floor}, {self._t.probability_ceil}]."
            )

        # Evaluate gates -> status + reason.
        status, reason, blocking_risks = self._evaluate_gates(win_p, signals, game)
        signals.risks.extend(blocking_risks)

        # Handicap decision is independent of the normal-win decision.
        handicap_decision = evaluate_handicap(game, handicap, raw, self._t)

        tier = ConfidenceTier.NONE
        risk_level = self._risk_level(signals)
        expected_home = raw.raw_team_score_expectations.get("home")
        expected_away = raw.raw_team_score_expectations.get("away")

        if status is DecisionStatus.PREDICT:
            tier = tier_for_probability(win_p, League(payload.league))
            return GameDecision(
                match_id=game.match_id,
                selected_team=selected,
                predicted_loser=loser,
                normal_win_probability=win_p,
                normal_loss_probability=loss_p,
                confidence_tier=tier,
                risk_level=risk_level,
                decision_status=DecisionStatus.PREDICT,
                pass_reason=None,
                supporting_factors=tuple(signals.supporting),
                risk_factors=tuple(signals.risks),
                calibration_notes=tuple(calibration_notes),
                expected_score_home=expected_home,
                expected_score_away=expected_away,
                handicap=handicap_decision,
            )

        # Non-predict: still report the leaning probabilities for auditability, but
        # no confidence tier and no selected team is promoted.
        return GameDecision(
            match_id=game.match_id,
            selected_team=None,
            predicted_loser=None,
            normal_win_probability=win_p,
            normal_loss_probability=loss_p,
            confidence_tier=ConfidenceTier.NONE,
            risk_level=risk_level,
            decision_status=status,
            pass_reason=reason,
            supporting_factors=tuple(signals.supporting),
            risk_factors=tuple(signals.risks),
            calibration_notes=tuple(calibration_notes),
            expected_score_home=expected_home,
            expected_score_away=expected_away,
            handicap=_neutralize_handicap_on_nonpredict(handicap_decision, status),
        )

    # ------------------------------------------------------------------ #

    def _gather_signals(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        calib_home: CalibrationResult,
        calib_away: CalibrationResult,
    ) -> _Signals:
        supporting: list[str] = []
        risks: list[str] = []

        completeness = game.feature_summary.completeness
        if completeness is None:
            # Fall back to evidence-quality-based completeness estimate.
            if game.evidence:
                ok = sum(1 for e in game.evidence if e.quality == DataQualityStatus.OK)
                completeness = ok / len(game.evidence)
            else:
                completeness = 0.0
        evidence_completeness = Decimal(str(round(completeness, 4)))
        if evidence_completeness >= self._t.min_evidence_completeness:
            supporting.append(f"evidence_completeness={evidence_completeness}")
        else:
            risks.append(f"low_evidence_completeness={evidence_completeness}")

        staleness = self._staleness_minutes(game, payload)
        if staleness is not None and staleness > self._t.max_data_staleness_minutes:
            risks.append(f"data_stale_minutes={staleness}")
        elif staleness is not None:
            supporting.append(f"data_fresh_minutes={staleness}")

        starter_confirmed = any(
            s.confirmed for s in game.probable_or_confirmed_starters
        ) or (game.starter_status or "").upper() == "CONFIRMED"
        if starter_confirmed:
            supporting.append("starter_confirmed")
        else:
            risks.append("starter_unconfirmed")

        schedule_validated = game.validation_status is ValidationStatus.VALIDATED
        if schedule_validated:
            supporting.append("schedule_validated")
        else:
            risks.append("schedule_unvalidated")

        disagreement = _extract_disagreement(raw.inference_warnings)
        if disagreement is not None:
            if disagreement <= self._t.max_model_disagreement:
                supporting.append(f"model_disagreement={disagreement}")
            else:
                risks.append(f"high_model_disagreement={disagreement}")

        market_disagreement = _market_disagreement(game, calib_home.adjusted_probability)
        if (
            market_disagreement is not None
            and market_disagreement > self._t.max_market_disagreement
        ):
            risks.append(f"high_market_disagreement={market_disagreement}")

        critical_count = _critical_risk_count(game)
        if critical_count:
            risks.append(f"critical_risk_flags={critical_count}")

        return _Signals(
            calibrated_home=calib_home.adjusted_probability,
            calibrated_away=calib_away.adjusted_probability,
            evidence_completeness=evidence_completeness,
            staleness_minutes=staleness,
            starter_confirmed=starter_confirmed,
            schedule_validated=schedule_validated,
            model_disagreement=disagreement,
            market_disagreement=market_disagreement,
            critical_risk_count=critical_count,
            supporting=supporting,
            risks=risks,
        )

    def _evaluate_gates(
        self, win_p: Decimal, s: _Signals, game: ControlTowerGame
    ) -> tuple[DecisionStatus, str | None, list[str]]:
        blocking: list[str] = []

        # BLOCKED conditions (hard data-integrity failures).
        if self._t.require_schedule_validation and not s.schedule_validated:
            return (
                DecisionStatus.BLOCKED,
                "official schedule validation required but absent",
                blocking,
            )
        if self._t.max_critical_risk_count is not None and (
            s.critical_risk_count > self._t.max_critical_risk_count
        ):
            return (
                DecisionStatus.BLOCKED,
                f"critical risk count {s.critical_risk_count} exceeds "
                f"max {self._t.max_critical_risk_count}",
                blocking,
            )

        # PASS conditions (insufficient confidence / quality to predict).
        if win_p < self._t.min_prediction_probability:
            return DecisionStatus.PASS, (
                f"calibrated probability {win_p} below minimum "
                f"{self._t.min_prediction_probability}"
            ), blocking
        if s.evidence_completeness < self._t.min_evidence_completeness:
            return DecisionStatus.PASS, (
                f"evidence completeness {s.evidence_completeness} below minimum "
                f"{self._t.min_evidence_completeness}"
            ), blocking
        if s.staleness_minutes is not None and (
            s.staleness_minutes > self._t.max_data_staleness_minutes
        ):
            return DecisionStatus.PASS, (
                f"data staleness {s.staleness_minutes}m exceeds max "
                f"{self._t.max_data_staleness_minutes}m"
            ), blocking
        if self._t.require_starter_confirmation and not s.starter_confirmed:
            return DecisionStatus.PASS, "starter confirmation required but missing", blocking
        if s.model_disagreement is not None and (
            s.model_disagreement > self._t.max_model_disagreement
        ):
            return DecisionStatus.PASS, (
                f"model disagreement {s.model_disagreement} exceeds max "
                f"{self._t.max_model_disagreement}"
            ), blocking

        return DecisionStatus.PREDICT, None, blocking

    def _risk_level(self, s: _Signals) -> RiskLevel:
        if s.critical_risk_count > 0:
            return RiskLevel.CRITICAL
        risk_count = len(s.risks)
        if risk_count >= 3:
            return RiskLevel.HIGH
        if risk_count >= 1:
            return RiskLevel.MEDIUM
        return RiskLevel.LOW

    @staticmethod
    def _staleness_minutes(
        game: ControlTowerGame, payload: ControlTowerPayload
    ) -> int | None:
        stamps: list[datetime] = []
        for value in (
            payload.source_freshness.odds_fetched_at,
            payload.source_freshness.lineup_fetched_at,
            payload.source_freshness.schedule_fetched_at,
        ):
            if value is not None:
                stamps.append(to_utc(value))
        if not stamps:
            return None
        oldest = min(stamps)
        delta = to_utc(payload.generated_at) - oldest
        return int(delta.total_seconds() // 60)


def _extract_disagreement(warnings: tuple[str, ...]) -> Decimal | None:
    for w in warnings:
        if w.startswith("model_disagreement="):
            try:
                return Decimal(w.split("=", 1)[1])
            except Exception:  # noqa: BLE001 - defensive parse only
                return None
    return None


def _market_disagreement(
    game: ControlTowerGame, model_home_prob: Decimal
) -> Decimal | None:
    implied = game.market_summary.get("implied_home_win_probability")
    if implied is None:
        return None
    try:
        return (model_home_prob - Decimal(str(implied))).copy_abs()
    except Exception:  # noqa: BLE001
        return None


def _critical_risk_count(game: ControlTowerGame) -> int:
    flags = game.risk_summary.get("critical_flags")
    if isinstance(flags, list):
        return len(flags)
    if isinstance(flags, int):
        return flags
    return 0


def _neutralize_handicap_on_nonpredict(
    decision: HandicapDecision, status: DecisionStatus
) -> HandicapDecision:
    # When the whole game is BLOCKED/INVALID, propagate to the handicap decision
    # so it is not presented as an actionable pick.
    if status in (DecisionStatus.BLOCKED, DecisionStatus.INVALID):
        return decision.model_copy(
            update={
                "handicap_decision_status": HandicapDecisionStatus.BLOCKED,
                "handicap_pass_reason": decision.handicap_pass_reason
                or f"game decision {status.value}",
                "handicap_pick": None,
            }
        )
    return decision
