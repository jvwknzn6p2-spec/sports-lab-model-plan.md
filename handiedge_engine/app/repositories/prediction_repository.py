"""Persistence for prediction runs, payloads, predictions, decisions, calibration."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.infrastructure.database.models import (
    CalibrationRecord,
    ControlTowerPayloadRecord,
    DecisionRecord,
    GamePredictionRecord,
    PredictionRun,
)


class PredictionRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    # --- runs --------------------------------------------------------------
    def get_run_by_run_id(self, run_id: str) -> PredictionRun | None:
        stmt = select(PredictionRun).where(PredictionRun.run_id == run_id)
        return self.session.scalars(stmt).one_or_none()

    def add_run(self, run: PredictionRun) -> PredictionRun:
        self.session.add(run)
        self.session.flush()
        return run

    def get_prediction(self, prediction_id: str) -> GamePredictionRecord | None:
        return self.session.get(GamePredictionRecord, prediction_id)

    def add_payload(self, payload: ControlTowerPayloadRecord) -> None:
        self.session.add(payload)

    def add_prediction(self, prediction: GamePredictionRecord) -> None:
        self.session.add(prediction)

    def add_decision(self, decision: DecisionRecord) -> None:
        self.session.add(decision)

    def add_calibration(self, calibration: CalibrationRecord) -> None:
        self.session.add(calibration)
