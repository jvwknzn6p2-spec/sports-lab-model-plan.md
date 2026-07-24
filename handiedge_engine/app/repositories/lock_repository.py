"""Persistence for prediction locks."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.enums import LockStatus
from app.infrastructure.database.models import PredictionLock


class LockRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, lock_id: str) -> PredictionLock | None:
        return self.session.get(PredictionLock, lock_id)

    def get_active_for_prediction(self, prediction_id: str) -> PredictionLock | None:
        stmt = select(PredictionLock).where(
            PredictionLock.prediction_id == prediction_id,
            PredictionLock.lock_status == LockStatus.LOCKED.value,
        )
        return self.session.scalars(stmt).one_or_none()

    def max_version_for_match(self, run_id: str, match_id: str) -> int:
        stmt = select(PredictionLock).where(
            PredictionLock.run_id == run_id, PredictionLock.match_id == match_id
        )
        rows = self.session.scalars(stmt).all()
        return max((r.version for r in rows), default=0)

    def add(self, lock: PredictionLock) -> PredictionLock:
        self.session.add(lock)
        self.session.flush()
        return lock
