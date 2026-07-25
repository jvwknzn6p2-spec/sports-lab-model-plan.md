"""Enumerations for all HandiEdge Engine state machines and controlled vocabularies.

Every state in the pipeline is modelled as a string-backed Enum so that values
serialize cleanly to JSON/JSONB and remain stable across schema versions.
"""

from __future__ import annotations

from enum import Enum


class StrEnum(str, Enum):  # noqa: UP042 - explicit str mixin for stable JSON values
    """String enum whose ``str()`` and JSON form is the member value."""

    def __str__(self) -> str:  # pragma: no cover - trivial
        return str(self.value)


class League(StrEnum):
    MLB = "MLB"
    NPB = "NPB"


class Sport(StrEnum):
    BASEBALL = "BASEBALL"


class SettlementScope(StrEnum):
    MLB_FINAL_INCL_EXTRA = "MLB_FINAL_INCL_EXTRA"
    NPB_REG9_ONLY = "NPB_REG9_ONLY"


class ControlTowerStatus(StrEnum):
    PASS = "PASS"
    BLOCKED = "BLOCKED"
    REJECTED = "REJECTED"


class DataQualityStatus(StrEnum):
    OK = "OK"
    DEGRADED = "DEGRADED"
    STALE = "STALE"
    INSUFFICIENT = "INSUFFICIENT"


class ValidationStatus(StrEnum):
    VALIDATED = "VALIDATED"
    UNVALIDATED = "UNVALIDATED"
    FAILED = "FAILED"


class PredictionStatus(StrEnum):
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"


class ModelType(StrEnum):
    XGBOOST = "XGBOOST"
    LIGHTGBM = "LIGHTGBM"
    CATBOOST = "CATBOOST"
    ELO = "ELO"
    BAYESIAN = "BAYESIAN"
    POISSON = "POISSON"
    MARKET = "MARKET"
    ENSEMBLE = "ENSEMBLE"
    META = "META"
    DETERMINISTIC_FALLBACK = "DETERMINISTIC_FALLBACK"


class DecisionStatus(StrEnum):
    PREDICT = "PREDICT"
    PASS = "PASS"
    BLOCKED = "BLOCKED"
    INVALID = "INVALID"


class HandicapDecisionStatus(StrEnum):
    PREDICT = "PREDICT"
    PASS = "PASS"
    BLOCKED = "BLOCKED"
    UNAVAILABLE = "UNAVAILABLE"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class HandicapType(StrEnum):
    """The kind of handicap notation parsed from the source string."""

    INTEGER = "INTEGER"            # e.g. "0", "1"
    DECIMAL = "DECIMAL"           # e.g. "0.5", "1.25"
    JP_HALF = "JP_HALF"          # e.g. "1半"  (Japanese half notation - NOT 1.5)
    JP_HALF_SUB = "JP_HALF_SUB"  # e.g. "1半3" (half with sub number 1..9)
    UNRESOLVED = "UNRESOLVED"    # unsupported / ambiguous / incomplete


class HandicapRuleStatus(StrEnum):
    RESOLVED = "RESOLVED"
    UNRESOLVED = "UNRESOLVED"


class HandicapSide(StrEnum):
    FAVORITE = "FAVORITE"
    RECEIVER = "RECEIVER"


class CalibrationMethod(StrEnum):
    IDENTITY = "IDENTITY"
    PLATT = "PLATT"
    ISOTONIC = "ISOTONIC"


class CalibrationStatus(StrEnum):
    CALIBRATED = "CALIBRATED"
    UNCALIBRATED = "UNCALIBRATED"


class LockStatus(StrEnum):
    UNLOCKED = "UNLOCKED"
    LOCKED = "LOCKED"
    VOIDED = "VOIDED"
    SUPERSEDED = "SUPERSEDED"


class GameStatus(StrEnum):
    FINAL = "FINAL"
    POSTPONED = "POSTPONED"
    CANCELLED = "CANCELLED"
    SUSPENDED = "SUSPENDED"
    NO_CONTEST = "NO_CONTEST"
    IN_PROGRESS = "IN_PROGRESS"


class SettlementStatus(StrEnum):
    SETTLED = "SETTLED"
    VOID = "VOID"
    PENDING = "PENDING"
    CONFLICT = "CONFLICT"


class PredictionResult(StrEnum):
    WIN = "WIN"
    LOSS = "LOSS"
    PUSH = "PUSH"
    PARTIAL_WIN = "PARTIAL_WIN"
    PARTIAL_LOSS = "PARTIAL_LOSS"
    VOID = "VOID"
    NOT_SETTLED = "NOT_SETTLED"


class ErrorCategory(StrEnum):
    STARTER_CHANGE = "STARTER_CHANGE"
    LINEUP_CHANGE = "LINEUP_CHANGE"
    BULLPEN_FATIGUE = "BULLPEN_FATIGUE"
    WEATHER_IMPACT = "WEATHER_IMPACT"
    MARKET_MOVE = "MARKET_MOVE"
    DATA_STALENESS = "DATA_STALENESS"
    DATA_MISSING = "DATA_MISSING"
    MODEL_MISREAD = "MODEL_MISREAD"
    CALIBRATION_ERROR = "CALIBRATION_ERROR"
    HANDICAP_MARGIN_ERROR = "HANDICAP_MARGIN_ERROR"
    HIGH_VARIANCE_EVENT = "HIGH_VARIANCE_EVENT"
    EXTRA_INNINGS_VARIANCE = "EXTRA_INNINGS_VARIANCE"
    UNKNOWN = "UNKNOWN"


class LearningWorkflowStatus(StrEnum):
    PENDING_DATA = "PENDING_DATA"
    DATA_VALIDATED = "DATA_VALIDATED"
    LEAKAGE_CHECKED = "LEAKAGE_CHECKED"
    READY_FOR_TRAINING = "READY_FOR_TRAINING"
    TRAINING = "TRAINING"
    BACKTESTING = "BACKTESTING"
    OOS_VALIDATION = "OOS_VALIDATION"
    CALIBRATION_VALIDATION = "CALIBRATION_VALIDATION"
    CHALLENGER_READY = "CHALLENGER_READY"
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    DEPLOYED = "DEPLOYED"
    FAILED = "FAILED"


class ConfidenceTier(StrEnum):
    S_PLUS = "S+"
    S = "S"
    S_MINUS = "S-"
    A_PLUS = "A+"
    A = "A"
    A_MINUS = "A-"
    B_PLUS = "B+"
    B = "B"
    B_MINUS = "B-"
    C_PLUS = "C+"
    C = "C"
    C_MINUS = "C-"
    NONE = "NONE"


class AuditEventType(StrEnum):
    CONTROL_TOWER_ACCEPTED = "CONTROL_TOWER_ACCEPTED"
    CONTROL_TOWER_REJECTED = "CONTROL_TOWER_REJECTED"
    PREDICTION_GENERATED = "PREDICTION_GENERATED"
    FALLBACK_MODEL_USED = "FALLBACK_MODEL_USED"
    DECISION_PASSED = "DECISION_PASSED"
    DECISION_BLOCKED = "DECISION_BLOCKED"
    CALIBRATION_APPLIED = "CALIBRATION_APPLIED"
    AI_REVIEW_APPLIED = "AI_REVIEW_APPLIED"
    PREDICTION_LOCKED = "PREDICTION_LOCKED"
    PREDICTION_SUPERSEDED = "PREDICTION_SUPERSEDED"
    RESULT_SETTLED = "RESULT_SETTLED"
    SETTLEMENT_CONFLICT_DETECTED = "SETTLEMENT_CONFLICT_DETECTED"
    ERROR_ANALYSIS_GENERATED = "ERROR_ANALYSIS_GENERATED"
    LEARNING_WORKFLOW_CREATED = "LEARNING_WORKFLOW_CREATED"
    LEARNING_WORKFLOW_ADVANCED = "LEARNING_WORKFLOW_ADVANCED"
    MODEL_APPROVED = "MODEL_APPROVED"
    MODEL_REJECTED = "MODEL_REJECTED"
    MODEL_DEPLOYED = "MODEL_DEPLOYED"
