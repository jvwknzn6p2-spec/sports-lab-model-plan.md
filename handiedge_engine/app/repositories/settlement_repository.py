"""Persistence for settlement records."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.infrastructure.database.models import SettlementRecord


class SettlementRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, settlement_id: str) -> SettlementRecord | None:
        return self.session.get(SettlementRecord, settlement_id)

    def find_by_lock(self, prediction_lock_id: str) -> list[SettlementRecord]:
        stmt = select(SettlementRecord).where(
            SettlementRecord.prediction_lock_id == prediction_lock_id
        )
        return list(self.session.scalars(stmt).all())

    def find_by_lock_and_input(
        self, prediction_lock_id: str, input_hash: str
    ) -> SettlementRecord | None:
        stmt = select(SettlementRecord).where(
            SettlementRecord.prediction_lock_id == prediction_lock_id,
            SettlementRecord.input_hash == input_hash,
        )
        return self.session.scalars(stmt).one_or_none()

    def add(self, record: SettlementRecord) -> SettlementRecord:
        self.session.add(record)
        self.session.flush()
        return record
