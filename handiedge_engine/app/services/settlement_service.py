"""Settlement service.

Wraps the pure settlement engine with persistence, idempotency, and conflict
detection. Repeated settlement with identical inputs is idempotent; a different
official result for an already-settled lock raises a conflict and is recorded as
an audit event rather than silently overwriting the original.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.clock import isoformat_utc
from app.core.config import Settings
from app.core.enums import AuditEventType, SettlementScope, SettlementStatus
from app.core.exceptions import NotFoundError, SettlementConflictError
from app.core.hashing import sha256_hex
from app.domain.settlement.engine import settle
from app.infrastructure.database.models import SettlementRecord
from app.repositories.lock_repository import LockRepository
from app.repositories.settlement_repository import SettlementRepository
from app.schemas.settlement import SettlementInput, SettlementResponse
from app.services.audit_service import AuditService


class SettlementService:
    def __init__(self, session: Session, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._settlements = SettlementRepository(session)
        self._locks = LockRepository(session)
        self._audit = AuditService(session)

    def settle(
        self, si: SettlementInput, correlation_id: str | None = None
    ) -> SettlementResponse:
        lock = self._locks.get(si.prediction_lock_id)
        if lock is None:
            raise NotFoundError(f"lock {si.prediction_lock_id} not found")

        input_hash = sha256_hex(si.model_dump(mode="json"))

        # Idempotent replay: identical settlement input already recorded.
        existing_same = self._settlements.find_by_lock_and_input(
            si.prediction_lock_id, input_hash
        )
        if existing_same is not None:
            return SettlementResponse.model_validate(existing_same.payload)

        # Conflict: a different official result already settled this lock.
        prior = self._settlements.find_by_lock(si.prediction_lock_id)
        prior_scored = [p for p in prior if p.settlement_status == SettlementStatus.SETTLED.value]
        if prior_scored:
            self._audit.record(
                AuditEventType.SETTLEMENT_CONFLICT_DETECTED,
                aggregate_type="prediction_lock",
                aggregate_id=si.prediction_lock_id,
                reason="conflicting official result submitted",
                correlation_id=correlation_id,
                payload_hash=input_hash,
                metadata={"existing_settlement_id": prior_scored[0].id},
            )
            self._session.flush()
            raise SettlementConflictError(
                "lock already settled with a different official result",
                details={
                    "existing_settlement_id": prior_scored[0].id,
                    "existing_input_hash": prior_scored[0].input_hash,
                },
            )

        fp = lock.final_prediction
        scope = SettlementScope(fp["settlement_scope"])
        outcome = settle(
            scope=scope,
            selected_team=fp.get("selected_team"),
            home=fp["home"],
            away=fp["away"],
            handicap_raw=fp.get("handicap_raw"),
            favorite=fp.get("favorite"),
            receiver=fp.get("receiver"),
            si=si,
        )

        response = SettlementResponse(
            settlement_id="",  # filled after persistence
            prediction_lock_id=si.prediction_lock_id,
            normal_prediction_result=outcome.normal_result,
            handicap_prediction_result=outcome.handicap_result,
            settlement_status=outcome.settlement_status,
            winning_team=outcome.winning_team,
            losing_team=outcome.losing_team,
            settlement_score_home=outcome.score_home,
            settlement_score_away=outcome.score_away,
            push=outcome.push,
            partial_win=outcome.partial_win,
            partial_loss=outcome.partial_loss,
            void_reason=outcome.void_reason,
            result_source=si.official_result_source,
            result_timestamp=isoformat_utc(si.official_result_timestamp),
            settlement_rule_version=self._settings.settlement_rule_version,
            settlement_scope=scope.value,
        )

        record = SettlementRecord(
            prediction_lock_id=si.prediction_lock_id,
            input_hash=input_hash,
            settlement_scope=scope.value,
            settlement_status=outcome.settlement_status.value,
            normal_prediction_result=outcome.normal_result.value,
            handicap_prediction_result=outcome.handicap_result.value,
            settlement_rule_version=self._settings.settlement_rule_version,
            result_source=si.official_result_source,
            payload={},
        )
        self._settlements.add(record)
        response.settlement_id = record.id
        record.payload = response.model_dump(mode="json")

        self._audit.record(
            AuditEventType.RESULT_SETTLED,
            aggregate_type="settlement",
            aggregate_id=record.id,
            new_state=outcome.settlement_status.value,
            reason=outcome.void_reason,
            correlation_id=correlation_id,
            payload_hash=input_hash,
            metadata={
                "normal_result": outcome.normal_result.value,
                "handicap_result": outcome.handicap_result.value,
            },
        )
        self._session.flush()
        return response

    def get(self, settlement_id: str) -> SettlementResponse:
        record = self._settlements.get(settlement_id)
        if record is None:
            raise NotFoundError(f"settlement {settlement_id} not found")
        return SettlementResponse.model_validate(record.payload)
