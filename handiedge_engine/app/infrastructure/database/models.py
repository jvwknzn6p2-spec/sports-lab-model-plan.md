"""SQLAlchemy ORM models for all persisted aggregates.

Structured payload sections use JSONB on PostgreSQL (generic JSON on SQLite).
Surrogate keys are UUID strings; hashes, versions, and optimistic-concurrency
version numbers are stored on the aggregates that require them.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.infrastructure.database.base import (
    Base,
    JSONVariant,
    TimestampMixin,
    UUIDPKMixin,
)


class PredictionRun(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "prediction_runs"
    __table_args__ = (UniqueConstraint("run_id", name="uq_prediction_runs_run_id"),)

    run_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    league: Mapped[str] = mapped_column(String(16), nullable=False)
    settlement_scope: Mapped[str] = mapped_column(String(48), nullable=False)
    slate_date: Mapped[str] = mapped_column(String(16), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    control_tower_status: Mapped[str] = mapped_column(String(16), nullable=False)
    prediction_status: Mapped[str] = mapped_column(String(16), nullable=False)
    response_payload: Mapped[dict] = mapped_column(JSONVariant, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    payload: Mapped[ControlTowerPayloadRecord] = relationship(
        back_populates="run", uselist=False, cascade="all, delete-orphan"
    )
    predictions: Mapped[list[GamePredictionRecord]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class ControlTowerPayloadRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "control_tower_payloads"

    run_pk: Mapped[str] = mapped_column(
        ForeignKey("prediction_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str] = mapped_column(String(128), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    raw_payload: Mapped[dict] = mapped_column(JSONVariant, nullable=False)

    run: Mapped[PredictionRun] = relationship(back_populates="payload")


class GamePredictionRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "game_predictions"
    __table_args__ = (
        UniqueConstraint("run_pk", "match_id", name="uq_game_predictions_run_match"),
    )

    run_pk: Mapped[str] = mapped_column(
        ForeignKey("prediction_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    match_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    home: Mapped[str] = mapped_column(String(128), nullable=False)
    away: Mapped[str] = mapped_column(String(128), nullable=False)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    feature_snapshot_id: Mapped[str | None] = mapped_column(String(128))
    model_id: Mapped[str] = mapped_column(String(128), nullable=False)
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    raw_prediction: Mapped[dict] = mapped_column(JSONVariant, nullable=False)
    final_prediction: Mapped[dict] = mapped_column(JSONVariant, nullable=False)

    run: Mapped[PredictionRun] = relationship(back_populates="predictions")
    decision: Mapped[DecisionRecord] = relationship(
        back_populates="prediction", uselist=False, cascade="all, delete-orphan"
    )


class DecisionRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "decision_records"

    prediction_pk: Mapped[str] = mapped_column(
        ForeignKey("game_predictions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    decision_status: Mapped[str] = mapped_column(String(16), nullable=False)
    confidence_tier: Mapped[str] = mapped_column(String(8), nullable=False)
    risk_level: Mapped[str] = mapped_column(String(16), nullable=False)
    decision_policy_version: Mapped[str] = mapped_column(String(64), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONVariant, nullable=False)

    prediction: Mapped[GamePredictionRecord] = relationship(back_populates="decision")


class CalibrationRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "calibration_records"

    prediction_pk: Mapped[str] = mapped_column(
        ForeignKey("game_predictions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    artifact_id: Mapped[str | None] = mapped_column(String(128))
    version: Mapped[str] = mapped_column(String(64), nullable=False)
    original_probability: Mapped[str] = mapped_column(String(32), nullable=False)
    adjusted_probability: Mapped[str] = mapped_column(String(32), nullable=False)
    warning: Mapped[str | None] = mapped_column(Text)


class PredictionLock(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "prediction_locks"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "version", "run_id", name="uq_prediction_locks_match_version"
        ),
    )

    run_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    match_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    prediction_id: Mapped[str] = mapped_column(String(64), nullable=False)
    locked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    lock_deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    input_payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    feature_snapshot_hash: Mapped[str | None] = mapped_column(String(64))
    model_id: Mapped[str] = mapped_column(String(128), nullable=False)
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    calibration_version: Mapped[str] = mapped_column(String(64), nullable=False)
    decision_policy_version: Mapped[str] = mapped_column(String(64), nullable=False)
    final_prediction: Mapped[dict] = mapped_column(JSONVariant, nullable=False)
    lock_status: Mapped[str] = mapped_column(String(16), nullable=False, default="LOCKED")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    superseded_by: Mapped[str | None] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    audit_metadata: Mapped[dict] = mapped_column(JSONVariant, default=dict)


class SettlementRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "settlement_records"
    __table_args__ = (
        UniqueConstraint(
            "prediction_lock_id", "input_hash", name="uq_settlement_lock_input"
        ),
    )

    prediction_lock_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    input_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    settlement_scope: Mapped[str] = mapped_column(String(48), nullable=False)
    settlement_status: Mapped[str] = mapped_column(String(16), nullable=False)
    normal_prediction_result: Mapped[str] = mapped_column(String(16), nullable=False)
    handicap_prediction_result: Mapped[str] = mapped_column(String(16), nullable=False)
    settlement_rule_version: Mapped[str] = mapped_column(String(64), nullable=False)
    result_source: Mapped[str | None] = mapped_column(String(128))
    payload: Mapped[dict] = mapped_column(JSONVariant, nullable=False)


class ErrorAnalysisRecord(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "error_analysis_records"
    __table_args__ = (
        UniqueConstraint("settlement_id", name="uq_error_analysis_settlement"),
    )

    settlement_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    prediction_lock_id: Mapped[str] = mapped_column(String(64), nullable=False)
    primary_error_category: Mapped[str] = mapped_column(String(32), nullable=False)
    retraining_eligibility: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSONVariant, nullable=False)


class LearningWorkflow(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "learning_workflows"

    settlement_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    league: Mapped[str] = mapped_column(String(16), nullable=False)
    season_segment: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    dataset_version: Mapped[str | None] = mapped_column(String(64))
    feature_version: Mapped[str | None] = mapped_column(String(64))
    model_version: Mapped[str | None] = mapped_column(String(64))
    calibration_version: Mapped[str | None] = mapped_column(String(64))
    history: Mapped[list] = mapped_column(JSONVariant, default=list)
    metrics: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[str] = mapped_column(String(64), default="system")


class DatasetVersion(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "dataset_versions"

    version_label: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    league: Mapped[str] = mapped_column(String(16), nullable=False)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    leakage_checked: Mapped[bool] = mapped_column(Boolean, default=False)
    metadata_json: Mapped[dict] = mapped_column(JSONVariant, default=dict)


class FeatureVersion(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "feature_versions"

    version_label: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    spec: Mapped[dict] = mapped_column(JSONVariant, default=dict)


class ModelVersion(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "model_versions"

    version_label: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    model_type: Mapped[str] = mapped_column(String(32), nullable=False)
    dataset_version: Mapped[str | None] = mapped_column(String(64))
    feature_version: Mapped[str | None] = mapped_column(String(64))
    calibration_version: Mapped[str | None] = mapped_column(String(64))
    metrics: Mapped[dict] = mapped_column(JSONVariant, default=dict)


class ModelRegistryEntry(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "model_registry_entries"
    __table_args__ = (
        UniqueConstraint("league", "role", name="uq_model_registry_league_role"),
    )

    league: Mapped[str] = mapped_column(String(16), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # CHAMPION / CHALLENGER
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String(64))
    metrics: Mapped[dict] = mapped_column(JSONVariant, default=dict)


class AuditEvent(UUIDPKMixin, TimestampMixin, Base):
    __tablename__ = "audit_events"

    event_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    aggregate_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    aggregate_id: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    actor: Mapped[str] = mapped_column(String(64), nullable=False)
    event_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    prior_state: Mapped[str | None] = mapped_column(String(48))
    new_state: Mapped[str | None] = mapped_column(String(48))
    reason: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[str | None] = mapped_column(String(64), index=True)
    causation_id: Mapped[str | None] = mapped_column(String(64))
    payload_hash: Mapped[str | None] = mapped_column(String(64))
    event_metadata: Mapped[dict] = mapped_column(JSONVariant, default=dict)
