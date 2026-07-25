"""Model adapter registry / factory.

Selects the active prediction adapter from configuration:

  * ``model_adapter="fallback"`` (default) -> NON-PRODUCTION deterministic adapter.
  * ``model_adapter="xgboost"``            -> trained XGBoost artifact bundle
    loaded from ``model_artifact_dir`` (see scripts/train_xgboost.py and the
    README "Production model adapter integration guide").

A concrete adapter can also be registered directly (tests, custom wiring).
"""

from __future__ import annotations

from app.core.config import Settings, get_settings
from app.core.exceptions import ConfigurationError
from app.core.logging import get_logger
from app.domain.prediction.adapter import PredictionAdapter
from app.domain.prediction.deterministic_fallback import DeterministicFallbackAdapter

logger = get_logger("model_adapters")

_ADAPTERS: dict[str, PredictionAdapter] = {}


def register_adapter(name: str, adapter: PredictionAdapter) -> None:
    _ADAPTERS[name] = adapter


def clear_adapters() -> None:
    """Drop all registered adapters (used by tests to avoid cross-test leakage)."""

    _ADAPTERS.clear()


def build_adapter(settings: Settings | None = None) -> PredictionAdapter:
    """Construct the adapter described by ``settings`` (does not cache)."""

    settings = settings or get_settings()
    choice = (settings.model_adapter or "fallback").lower()

    if choice == "xgboost":
        if not settings.model_artifact_dir:
            raise ConfigurationError(
                "model_adapter='xgboost' requires HANDIEDGE_MODEL_ARTIFACT_DIR"
            )
        # Imported lazily so the engine runs without xgboost/numpy installed.
        from app.infrastructure.model_adapters.xgboost_adapter import (
            XGBoostModelAdapter,
        )

        adapter = XGBoostModelAdapter.from_artifact(settings.model_artifact_dir)
        logger.info(
            "adapter_loaded",
            adapter="xgboost",
            model_id=adapter.info().model_id,
            model_version=adapter.info().model_version,
        )
        return adapter

    if choice == "fallback":
        logger.info("adapter_loaded", adapter="fallback", production=False)
        return DeterministicFallbackAdapter()

    raise ConfigurationError(f"unknown model_adapter: {settings.model_adapter!r}")


def get_adapter(name: str = "default") -> PredictionAdapter:
    """Return the active adapter, building it from settings on first use.

    A directly-registered adapter under ``name`` always takes precedence.
    """

    if name in _ADAPTERS:
        return _ADAPTERS[name]
    adapter = build_adapter()
    _ADAPTERS[name] = adapter
    return adapter
