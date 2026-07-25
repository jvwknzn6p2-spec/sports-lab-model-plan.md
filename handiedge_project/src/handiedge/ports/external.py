"""Ports for external systems that cannot be verified locally (categories 6, 11, 12).

For AWS/Terraform, OIDC providers, MLflow, vLLM, and live model/provider
integrations we define explicit interfaces + configuration validation and *truthful*
NotConfigured/NotReady behaviour — never fake implementations that pretend the
external system works. A real deployment supplies concrete adapters; the default
implementations here refuse honestly.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from ..config import Settings
from ..errors import NotConfigured, NotReady


@runtime_checkable
class ModelRegistryPort(Protocol):
    """Loads/promotes/rolls back model versions (category 12)."""

    def load_production_model(self, sport: str) -> tuple[Any, Any, str]: ...
    def reload(self) -> None: ...


class UnconfiguredModelRegistry:
    """Default registry: no MLflow/registry wired => refuses truthfully."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def load_production_model(self, sport: str) -> tuple[Any, Any, str]:
        if not self._settings.mlflow_tracking_uri:
            raise NotConfigured(
                "no MLFLOW_TRACKING_URI configured; cannot load a production model. "
                "Wire a real registry adapter or inject a model for offline use."
            )
        raise NotReady("MLflow configured but no model has been promoted to production")

    def reload(self) -> None:
        raise NotConfigured("model registry not configured")


@runtime_checkable
class InferenceServerPort(Protocol):
    """A vLLM-style inference endpoint (Kimi K3), internal-network only."""

    def health(self) -> bool: ...
    def complete(self, prompt: str, **kwargs: Any) -> str: ...


class UnconfiguredInferenceServer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def health(self) -> bool:
        return False

    def complete(self, prompt: str, **kwargs: Any) -> str:
        raise NotConfigured(
            "KIMI_K3_ENDPOINT not configured; no live inference. "
            "Kimi K3 open weights are a configurable placeholder pending release."
        )


@runtime_checkable
class OIDCVerifierPort(Protocol):
    """Verifies a JWT's signature, audience, issuer and expiry (category 11)."""

    def verify(self, token: str) -> dict[str, Any]: ...


class UnconfiguredOIDCVerifier:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def verify(self, token: str) -> dict[str, Any]:
        missing = [
            n
            for n, v in (
                ("OIDC_ISSUER", self._settings.oidc_issuer),
                ("OIDC_AUDIENCE", self._settings.oidc_audience),
                ("OIDC_JWKS_URL", self._settings.oidc_jwks_url),
            )
            if not v
        ]
        if missing:
            raise NotConfigured(f"OIDC not configured: missing {missing}")
        raise NotReady(
            "OIDC configured but signature verification adapter is not implemented "
            "in this offline build (would fetch JWKS and verify sig/aud/iss/exp)."
        )


def default_registry(settings: Settings) -> ModelRegistryPort:
    return UnconfiguredModelRegistry(settings)


def default_inference_server(settings: Settings) -> InferenceServerPort:
    return UnconfiguredInferenceServer(settings)


def default_oidc_verifier(settings: Settings) -> OIDCVerifierPort:
    return UnconfiguredOIDCVerifier(settings)
