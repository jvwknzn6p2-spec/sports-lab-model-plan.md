"""Persistence for learning workflows and the model registry."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.infrastructure.database.models import (
    DatasetVersion,
    LearningWorkflow,
    ModelRegistryEntry,
    ModelVersion,
)


class LearningWorkflowRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, workflow_id: str) -> LearningWorkflow | None:
        return self.session.get(LearningWorkflow, workflow_id)

    def add(self, workflow: LearningWorkflow) -> LearningWorkflow:
        self.session.add(workflow)
        self.session.flush()
        return workflow


class ModelRegistryRepository:
    def __init__(self, session: Session) -> None:
        self.session = session

    def get_champion(self, league: str) -> ModelRegistryEntry | None:
        stmt = select(ModelRegistryEntry).where(
            ModelRegistryEntry.league == league,
            ModelRegistryEntry.role == "CHAMPION",
        )
        return self.session.scalars(stmt).one_or_none()

    def upsert_entry(self, entry: ModelRegistryEntry) -> ModelRegistryEntry:
        self.session.add(entry)
        self.session.flush()
        return entry

    def add_model_version(self, mv: ModelVersion) -> ModelVersion:
        self.session.add(mv)
        self.session.flush()
        return mv

    def add_dataset_version(self, dv: DatasetVersion) -> DatasetVersion:
        self.session.add(dv)
        self.session.flush()
        return dv
