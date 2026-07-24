"""Prediction Lock service.

Locks are immutable: a locked prediction is never modified in place. Corrections
require an explicit supersession that creates a new version and marks the prior
lock SUPERSEDED. Late submissions (past the deadline) are rejected. Duplicate lock
operations are idempotent.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.core.clock import isoformat_utc, to_utc, utc_now
from app.core.config import Settings
from app.core.enums import AuditEventType, LockStatus
from app.core.exceptions import (
    ImmutableRecordError,
    LockDeadlineExceededError,
    NotFoundError,
)
from app.core.hashing import sha256_hex
from app.infrastructure.database.models import PredictionLock
from app.repositories.lock_repository import LockRepository
from app.repositories.prediction_repository import PredictionRepository
from app.schemas.lock import LockResponse
from app.services.audit_service import AuditService


class PredictionLockService:
    def __init__(self, session: Session, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._locks = LockRepository(session)
        self._predictions = PredictionRepository(session)
        self._audit = AuditService(session)

    def lock(
        self,
        prediction_id: str,
        *,
        created_by: str = "system",
        supersede: bool = False,
        correlation_id: str | None = None,
    ) -> LockResponse:
        prediction = self._predictions.get_prediction(prediction_id)
        if prediction is None:
            raise NotFoundError(f"prediction {prediction_id} not found")

        run = prediction.run
        payload_record = run.payload
        deadline = self._deadline(payload_record.raw_payload)
        now = utc_now()

        existing = self._locks.get_active_for_prediction(prediction_id)
        if existing is not None and not supersede:
            # Idempotent duplicate lock -> return the existing lock unchanged.
            return self._to_response(existing)
        if existing is not None and not supersede:  # pragma: no cover - defensive
            raise ImmutableRecordError("prediction already locked")

        if now > deadline:
            raise LockDeadlineExceededError(
                "prediction deadline has passed; lock rejected",
                details={"deadline": isoformat_utc(deadline), "now": isoformat_utc(now)},
            )

        version = self._locks.max_version_for_match(run.run_id, prediction.match_id) + 1
        feature_hash = (
            sha256_hex({"snapshot": prediction.feature_snapshot_id})
            if prediction.feature_snapshot_id
            else None
        )
        lock = PredictionLock(
            run_id=run.run_id,
            match_id=prediction.match_id,
            prediction_id=prediction_id,
            locked_at=now,
            lock_deadline=deadline,
            input_payload_hash=prediction.input_hash,
            feature_snapshot_hash=feature_hash,
            model_id=prediction.model_id,
            model_version=prediction.model_version,
            calibration_version=self._settings.calibration_version,
            decision_policy_version=self._settings.decision_policy_version,
            final_prediction=prediction.final_prediction,
            lock_status=LockStatus.LOCKED.value,
            version=version,
            created_by=created_by,
            audit_metadata={"correlation_id": correlation_id},
        )
        self._locks.add(lock)

        prior_state = None
        if existing is not None and supersede:
            existing.lock_status = LockStatus.SUPERSEDED.value
            existing.superseded_by = lock.id
            prior_state = LockStatus.LOCKED.value
            self._audit.record(
                AuditEventType.PREDICTION_SUPERSEDED,
                aggregate_type="prediction_lock",
                aggregate_id=existing.id,
                prior_state=LockStatus.LOCKED.value,
                new_state=LockStatus.SUPERSEDED.value,
                reason="superseded by new version",
                correlation_id=correlation_id,
                metadata={"superseded_by": lock.id},
            )

        self._audit.record(
            AuditEventType.PREDICTION_LOCKED,
            aggregate_type="prediction_lock",
            aggregate_id=lock.id,
            prior_state=prior_state,
            new_state=LockStatus.LOCKED.value,
            reason="prediction locked",
            correlation_id=correlation_id,
            payload_hash=prediction.input_hash,
            metadata={"version": version, "match_id": prediction.match_id},
        )
        self._session.flush()
        return self._to_response(lock)

    def get(self, lock_id: str) -> LockResponse:
        lock = self._locks.get(lock_id)
        if lock is None:
            raise NotFoundError(f"lock {lock_id} not found")
        return self._to_response(lock)

    @staticmethod
    def _deadline(raw_payload: dict) -> datetime:
        deadline = raw_payload.get("prediction_deadline")
        return to_utc(datetime.fromisoformat(str(deadline)))

    @staticmethod
    def _to_response(lock: PredictionLock) -> LockResponse:
        return LockResponse(
            prediction_lock_id=lock.id,
            run_id=lock.run_id,
            match_id=lock.match_id,
            prediction_id=lock.prediction_id,
            locked_at=isoformat_utc(lock.locked_at),
            lock_deadline=isoformat_utc(lock.lock_deadline),
            input_payload_hash=lock.input_payload_hash,
            feature_snapshot_hash=lock.feature_snapshot_hash,
            model_id=lock.model_id,
            model_version=lock.model_version,
            calibration_version=lock.calibration_version,
            decision_policy_version=lock.decision_policy_version,
            lock_status=LockStatus(lock.lock_status),
            version=lock.version,
            created_by=lock.created_by,
            final_prediction=lock.final_prediction,
        )
