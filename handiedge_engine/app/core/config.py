"""Typed application configuration.

All thresholds that steer the Decision Engine live here (or in
``DecisionThresholds``) so they are never scattered as magic numbers across
services. Values are overridable via environment variables (prefix ``HANDIEDGE_``)
and a ``.env`` file.
"""

from __future__ import annotations

from decimal import Decimal
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DecisionThresholds(BaseSettings):
    """Configurable gates for the Decision Engine. All values are typed."""

    model_config = SettingsConfigDict(env_prefix="HANDIEDGE_GATE_", extra="ignore")

    min_calibrated_probability: Decimal = Decimal("0.50")
    min_prediction_probability: Decimal = Decimal("0.50")
    min_evidence_completeness: Decimal = Decimal("0.60")
    max_model_disagreement: Decimal = Decimal("0.20")
    max_market_disagreement: Decimal = Decimal("0.25")
    max_data_staleness_minutes: int = 720
    require_starter_confirmation: bool = True
    require_schedule_validation: bool = True
    min_handicap_cover_probability: Decimal = Decimal("0.52")
    block_unresolved_handicap: bool = True
    max_critical_risk_count: int = 0
    # Probability clipping bounds (never claim 0/1 certainty).
    probability_floor: Decimal = Decimal("0.01")
    probability_ceil: Decimal = Decimal("0.99")


class Settings(BaseSettings):
    """Top-level runtime settings."""

    model_config = SettingsConfigDict(
        env_prefix="HANDIEDGE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "handiedge-engine"
    environment: str = "local"
    schema_version: str = "1.0.0"

    # Persistence. SQLite is supported for local unit tests; PostgreSQL is the
    # production default.
    database_url: str = "sqlite+pysqlite:///./handiedge.db"
    sql_echo: bool = False

    # Security / limits.
    api_key: str | None = Field(default=None, description="Static API key for MVP auth.")
    require_api_key: bool = False
    max_request_bytes: int = 2_000_000
    max_games_per_run: int = 40

    # Prediction model selection. "fallback" uses the NON-PRODUCTION deterministic
    # adapter; "xgboost" loads a trained artifact bundle from model_artifact_dir.
    model_adapter: str = "fallback"
    model_artifact_dir: str | None = None
    calibration_artifact_path: str | None = None

    # AI multi-agent review (Step 9). Enabled by default; runs offline
    # (deterministic guardrails only) unless an LLM provider is configured.
    ai_review_enabled: bool = True
    ai_review_policy_version: str = "ai-review-1.0.0"

    # Versioned policy identifiers embedded in locks and audit records.
    decision_policy_version: str = "decision-policy-1.0.0"
    settlement_rule_version: str = "settlement-rules-1.0.0"
    calibration_version: str = "calibration-identity-1.0.0"

    log_level: str = "INFO"
    log_json: bool = True

    thresholds: DecisionThresholds = Field(default_factory=DecisionThresholds)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Clear the cached settings (used by tests that mutate env vars)."""

    get_settings.cache_clear()
