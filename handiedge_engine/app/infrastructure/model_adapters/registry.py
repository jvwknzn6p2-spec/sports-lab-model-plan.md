"""Model adapter registry / factory.

Selects the active prediction adapter. For the MVP this returns the
NON_PRODUCTION deterministic fallback. Production deployments register a trained
adapter here (see README "Production model adapter integration guide").
"""

from __future__ import annotations

from app.domain.prediction.adapter import PredictionAdapter
from app.domain.prediction.deterministic_fallback import DeterministicFallbackAdapter

_ADAPTERS: dict[str, PredictionAdapter] = {}


def register_adapter(name: str, adapter: PredictionAdapter) -> None:
    _ADAPTERS[name] = adapter


def get_adapter(name: str = "default") -> PredictionAdapter:
    if name not in _ADAPTERS:
        # Lazily register the fallback so the pipeline is always runnable.
        _ADAPTERS.setdefault("default", DeterministicFallbackAdapter())
        if name != "default" and name not in _ADAPTERS:
            return _ADAPTERS["default"]
    return _ADAPTERS[name]
