"""Orchestration service.

Executes the Control Tower -> Prediction -> Calibration -> Decision slice in a
single transaction and returns the final prediction result. Locking, settlement,
error analysis and learning are later lifecycle operations handled elsewhere.

Idempotency: re-submitting an identical payload returns the persisted result;
re-submitting the same run_id with a different payload raises a conflict (handled
in the validation service).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.core.clock import isoformat_utc, utc_now
from app.core.config import Settings
from app.core.enums import (
    AuditEventType,
    DecisionStatus,
    PredictionStatus,
)
from app.core.hashing import sha256_hex
from app.core.logging import get_logger
from app.domain.decision.engine import DecisionEngine
from app.domain.handicap.parser import parse_handicap
from app.domain.prediction.adapter import PredictionAdapter
from app.infrastructure.database.models import (
    CalibrationRecord,
    ControlTowerPayloadRecord,
    DecisionRecord,
    GamePredictionRecord,
    PredictionRun,
)
from app.repositories.prediction_repository import PredictionRepository
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.decision import GameDecision
from app.schemas.prediction import (
    CalibrationContextOut,
    ExpectedScoreOut,
    GameAuditOut,
    GamePredictionOut,
    ModelContextOut,
    PredictionRunResponse,
    PredictionSummaryOut,
    RawGamePrediction,
)
from app.services.audit_service import AuditService
from app.services.calibration_service import CalibrationService
from app.services.control_tower_validation_service import ControlTowerValidationService
from app.services.prediction_service import PredictionService

logger = get_logger("orchestration")


class OrchestrationService:
    def __init__(
        self,
        session: Session,
        settings: Settings,
        adapter: PredictionAdapter,
    ) -> None:
        self._session = session
        self._settings = settings
        self._adapter = adapter
        self._repo = PredictionRepository(session)
        self._audit = AuditService(session)
        self._validation = ControlTowerValidationService(
            session, settings.max_games_per_run
        )
        self._prediction = PredictionService(adapter)
        self._calibration = CalibrationService(settings)
        self._decision = DecisionEngine(settings.thresholds)

    def run_pipeline(
        self, raw_payload: dict[str, Any], correlation_id: str | None = None
    ) -> PredictionRunResponse:
        validated = self._validation.validate(raw_payload)

        # Idempotent replay: identical payload already processed.
        if validated.existing_run is not None:
            logger.info(
                "idempotent_replay", run_id=validated.payload.run_id, correlation_id=correlation_id
            )
            return PredictionRunResponse.model_validate(
                validated.existing_run.response_payload
            )

        payload = validated.payload
        self._audit.record(
            AuditEventType.CONTROL_TOWER_ACCEPTED,
            aggregate_type="prediction_run",
            aggregate_id=payload.run_id,
            reason="payload validated",
            correlation_id=correlation_id,
            payload_hash=validated.payload_hash,
            metadata={"games": len(payload.games), "league": payload.league.value},
        )

        raw_bundle = self._prediction.predict(payload)
        if raw_bundle.context.fallback_used:
            self._audit.record(
                AuditEventType.FALLBACK_MODEL_USED,
                aggregate_type="prediction_run",
                aggregate_id=payload.run_id,
                reason="NON_PRODUCTION_FALLBACK adapter used",
                correlation_id=correlation_id,
            )

        # Persist run shell (response filled at the end).
        run = PredictionRun(
            run_id=payload.run_id,
            schema_version=payload.schema_version,
            league=payload.league.value,
            settlement_scope=payload.settlement_scope.value,
            slate_date=payload.slate_date.isoformat(),
            payload_hash=validated.payload_hash,
            control_tower_status=payload.control_tower_status.value,
            prediction_status=PredictionStatus.COMPLETED.value,
            response_payload={},
        )
        self._repo.add_run(run)
        self._repo.add_payload(
            ControlTowerPayloadRecord(
                run_pk=run.id,
                run_id=payload.run_id,
                schema_version=payload.schema_version,
                payload_hash=validated.payload_hash,
                raw_payload=payload.model_dump(mode="json"),
            )
        )

        calibrator = self._calibration.get_calibrator(payload.league.value)
        raw_by_match = {g.match_id: g for g in raw_bundle.games}

        game_outputs: list[GamePredictionOut] = []
        calib_ctx: CalibrationContextOut | None = None
        for game in payload.games:
            raw = raw_by_match[game.match_id]
            decision, calib_home, calib_away = self._decide_game(game, payload, raw, calibrator)
            if calib_ctx is None:
                calib_ctx = CalibrationContextOut(
                    method=calib_home.method.value,
                    status=calib_home.status.value,
                    artifact_id=calib_home.artifact_id,
                    version=calib_home.version,
                    warning=calib_home.warning,
                )

            out = self._build_game_output(game, payload, raw, decision)
            game_outputs.append(out)
            self._persist_game(run, game, payload, raw, decision, out, calib_home, calib_away)
            self._audit_decision(payload.run_id, out, decision, correlation_id)

        response = PredictionRunResponse(
            schema_version=payload.schema_version,
            run_id=payload.run_id,
            league=payload.league.value,
            slate_date=payload.slate_date.isoformat(),
            generated_at=isoformat_utc(payload.generated_at),
            control_tower_status=payload.control_tower_status.value,
            prediction_status=PredictionStatus.COMPLETED.value,
            model_context=ModelContextOut(
                model_id=raw_bundle.context.model_id,
                model_version=raw_bundle.context.model_version,
                fallback_used=raw_bundle.context.fallback_used,
            ),
            calibration_context=calib_ctx
            or CalibrationContextOut(method="IDENTITY", status="UNCALIBRATED"),
            games=game_outputs,
            summary=self._summarize(game_outputs, raw_bundle),
        )
        run.response_payload = response.model_dump(mode="json")
        self._session.flush()
        return response

    # ------------------------------------------------------------------ #

    def _decide_game(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        calibrator,
    ) -> tuple[GameDecision, Any, Any]:
        calib_home = calibrator.calibrate(raw.raw_home_win_probability)
        calib_away = calibrator.calibrate(raw.raw_away_win_probability)
        handicap = parse_handicap(
            game.handicap_raw, favorite=game.favorite, receiver=game.receiver
        )
        decision = self._decision.decide(
            game, payload, raw, calib_home, calib_away, handicap
        )
        return decision, calib_home, calib_away

    def _build_game_output(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        decision: GameDecision,
    ) -> GamePredictionOut:
        prediction_id = sha256_hex(
            {"run_id": payload.run_id, "match_id": game.match_id}
        )[:32]
        input_hash = sha256_hex(game.model_dump(mode="json"))
        h = decision.handicap
        return GamePredictionOut(
            match_id=game.match_id,
            home=game.home,
            away=game.away,
            selected_team=decision.selected_team,
            predicted_loser=decision.predicted_loser,
            normal_win_probability=_f(decision.normal_win_probability),
            normal_loss_probability=_f(decision.normal_loss_probability),
            handicap_pick=h.handicap_pick,
            handicap_cover_probability=_f(h.handicap_cover_probability),
            confidence_tier=decision.confidence_tier.value,
            risk_level=decision.risk_level.value,
            expected_score=ExpectedScoreOut(
                home=_f(decision.expected_score_home),
                away=_f(decision.expected_score_away),
            ),
            decision_status=decision.decision_status.value,
            pass_reason=decision.pass_reason,
            supporting_factors=list(decision.supporting_factors),
            risk_factors=list(decision.risk_factors),
            calibration_notes=list(decision.calibration_notes),
            data_quality_status=payload.data_quality_status.value,
            handicap_rule_status=h.handicap_rule_status,
            audit=GameAuditOut(
                prediction_id=prediction_id,
                input_hash=input_hash,
                feature_snapshot_id=raw.feature_snapshot_id,
                created_at=isoformat_utc(utc_now()),
            ),
        )

    def _persist_game(
        self,
        run: PredictionRun,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        decision: GameDecision,
        out: GamePredictionOut,
        calib_home,
        calib_away,
    ) -> None:
        info = self._adapter.info()
        record = GamePredictionRecord(
            id=out.audit.prediction_id,
            run_pk=run.id,
            run_id=payload.run_id,
            match_id=game.match_id,
            home=game.home,
            away=game.away,
            input_hash=out.audit.input_hash,
            feature_snapshot_id=raw.feature_snapshot_id,
            model_id=info.model_id,
            model_version=info.model_version,
            fallback_used=raw.fallback_used,
            raw_prediction=raw.model_dump(mode="json"),
            final_prediction=self._lockable_prediction(game, payload, decision, out),
        )
        self._repo.add_prediction(record)
        # Flush the parent row so child FKs (decision, calibration) are satisfied
        # regardless of unit-of-work insert ordering.
        self._session.flush()
        self._repo.add_decision(
            DecisionRecord(
                prediction_pk=record.id,
                decision_status=decision.decision_status.value,
                confidence_tier=decision.confidence_tier.value,
                risk_level=decision.risk_level.value,
                decision_policy_version=self._settings.decision_policy_version,
                payload=out.model_dump(mode="json"),
            )
        )
        self._repo.add_calibration(
            CalibrationRecord(
                prediction_pk=record.id,
                method=calib_home.method.value,
                status=calib_home.status.value,
                artifact_id=calib_home.artifact_id,
                version=calib_home.version,
                original_probability=format(calib_home.original_probability, "f"),
                adjusted_probability=format(calib_home.adjusted_probability, "f"),
                warning=calib_home.warning,
            )
        )

    def _lockable_prediction(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        decision: GameDecision,
        out: GamePredictionOut,
    ) -> dict[str, Any]:
        """The self-contained prediction payload stored for locking + settlement."""

        data = out.model_dump(mode="json")
        data["league"] = payload.league.value
        data["settlement_scope"] = payload.settlement_scope.value
        # Flat expected-score keys for the error-analysis engine.
        data["expected_score_home"] = _f(decision.expected_score_home)
        data["expected_score_away"] = _f(decision.expected_score_away)
        data["handicap_raw"] = game.handicap_raw
        data["favorite"] = game.favorite
        data["receiver"] = game.receiver
        data["handicap_side"] = (
            decision.handicap.handicap_side.value
            if decision.handicap.handicap_side
            else None
        )
        return data

    def _audit_decision(
        self, run_id: str, out: GamePredictionOut, decision: GameDecision, correlation_id
    ) -> None:
        if decision.decision_status is DecisionStatus.BLOCKED:
            event = AuditEventType.DECISION_BLOCKED
        elif decision.decision_status is DecisionStatus.PASS:
            event = AuditEventType.DECISION_PASSED
        else:
            event = AuditEventType.PREDICTION_GENERATED
        self._audit.record(
            event,
            aggregate_type="game_prediction",
            aggregate_id=out.audit.prediction_id,
            new_state=decision.decision_status.value,
            reason=decision.pass_reason,
            correlation_id=correlation_id,
            payload_hash=out.audit.input_hash,
            metadata={"match_id": out.match_id, "run_id": run_id},
        )
        self._audit.record(
            AuditEventType.CALIBRATION_APPLIED,
            aggregate_type="game_prediction",
            aggregate_id=out.audit.prediction_id,
            correlation_id=correlation_id,
            metadata={"tier": decision.confidence_tier.value},
        )

    @staticmethod
    def _summarize(
        outputs: list[GamePredictionOut], raw_bundle
    ) -> PredictionSummaryOut:
        predicts = sum(1 for o in outputs if o.decision_status == DecisionStatus.PREDICT.value)
        passes = sum(1 for o in outputs if o.decision_status == DecisionStatus.PASS.value)
        blocked = sum(
            1
            for o in outputs
            if o.decision_status in (DecisionStatus.BLOCKED.value, DecisionStatus.INVALID.value)
        )
        fallback = sum(1 for g in raw_bundle.games if g.fallback_used)
        return PredictionSummaryOut(
            total_games=len(outputs),
            predictions=predicts,
            passes=passes,
            blocked=blocked,
            fallback_predictions=fallback,
        )


def _f(value) -> float | None:
    if value is None:
        return None
    return float(value)
