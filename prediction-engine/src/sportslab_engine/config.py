"""Runtime configuration and shared paths for the prediction engine.

Everything the pipeline needs to locate — fixtures, model artifacts, output
JSON — is resolved here so the rest of the code never hard-codes a path. Live
vs. fixture behavior for data ingestion is a single switch (`use_fixtures`)
governed by the ``SPORTSLAB_USE_FIXTURES`` env var, defaulting to fixtures
because this environment's egress policy blocks the external data APIs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parent  # .../prediction-engine/src/sportslab_engine
_PROJECT_ROOT = _PACKAGE_ROOT.parents[1]  # prediction-engine/


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class EngineConfig:
    """Resolved paths and switches for one pipeline run."""

    project_root: Path = _PROJECT_ROOT
    fixtures_dir: Path = _PACKAGE_ROOT / "ingest" / "fixtures"
    artifacts_dir: Path = _PROJECT_ROOT / "artifacts"
    output_dir: Path = _PROJECT_ROOT / "out"

    # When true (default here), ingestion reads recorded fixtures instead of
    # calling the live MLB / odds / weather APIs. Set SPORTSLAB_USE_FIXTURES=0
    # in an environment whose egress policy allows those hosts.
    use_fixtures: bool = field(
        default_factory=lambda: _env_flag("SPORTSLAB_USE_FIXTURES", True)
    )

    # MLB Stats API base (public, no key). Used only when use_fixtures is False.
    mlb_base_url: str = "https://statsapi.mlb.com/api/v1"

    def artifact(self, name: str) -> Path:
        return self.artifacts_dir / name

    def output(self, name: str) -> Path:
        return self.output_dir / name

    def ensure_dirs(self) -> None:
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)


DEFAULT_CONFIG = EngineConfig()
