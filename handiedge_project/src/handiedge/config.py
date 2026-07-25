"""Application settings.

Secrets and external endpoints are read from the environment only — never
hard-coded, never defaulted to a real value. Absence of a value is represented
truthfully so that ports can raise :class:`NotConfigured` instead of pretending
an external system is available.
"""

from __future__ import annotations

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HANDIEDGE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "dev"

    # --- external systems (all optional; absence => NotConfigured at use site) ---
    database_url: SecretStr | None = None
    audit_log_pepper: SecretStr | None = None

    kimi_k3_endpoint: str | None = None
    kimi_k3_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None

    oidc_issuer: str | None = None
    oidc_audience: str | None = None
    oidc_jwks_url: str | None = None

    mlflow_tracking_uri: str | None = None
    minio_endpoint: str | None = None
    minio_access_key: SecretStr | None = None
    minio_secret_key: SecretStr | None = None

    cost_guard_monthly_usd: float | None = None
    metrics_api_key: SecretStr | None = None

    # --- odds provider (OpticOdds-compatible) ---
    opticodds_base_url: str | None = None
    opticodds_api_key: SecretStr | None = None

    # --- live connector (programmatic external-tool; credentials injected by runtime) ---
    # No API key here by design: the runtime injects credentials into the connector.
    external_tool_bin: str = "external-tool"
    external_tool_timeout_s: float = 30.0
    opticodds_source_id: str = "opticodds"
    opticodds_tool_name: str = "opticodds"
    # US sportsbooks only (connector limitation). Max five per snapshot batch.
    opticodds_sportsbooks: str = "draftkings,fanduel,betmgm,caesars,espnbet"

    # --- local data lake (raw immutable snapshots, normalized rows, datasets, artifacts) ---
    data_dir: str = "./data"

    # --- responsible-gambling / jurisdiction policy ---
    # Comma-separated ISO-3166 alpha-2 codes that are *allowed*. Empty => allow all
    # non-blocked (dev default). Blocked list always takes precedence.
    allowed_jurisdictions: str = ""
    blocked_jurisdictions: str = ""
    min_age: int = 18

    # --- domain policy knobs ---
    stale_seconds: int = Field(
        default=300,
        description="Max age (seconds) of an odds quote before it is rejected for decisions.",
    )
    default_llm_model: str = "deepseek-v4-pro"

    @property
    def is_prod(self) -> bool:
        return self.environment.lower() == "prod"

    def allowed_jurisdiction_set(self) -> set[str]:
        return {c.strip().upper() for c in self.allowed_jurisdictions.split(",") if c.strip()}

    def blocked_jurisdiction_set(self) -> set[str]:
        return {c.strip().upper() for c in self.blocked_jurisdictions.split(",") if c.strip()}

    def sportsbook_list(self) -> list[str]:
        return [b.strip().lower() for b in self.opticodds_sportsbooks.split(",") if b.strip()]


def get_settings(**overrides: object) -> Settings:
    """Construct settings, allowing explicit overrides for tests (no global singleton)."""
    return Settings(**overrides)  # type: ignore[arg-type]
