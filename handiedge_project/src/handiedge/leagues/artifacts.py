"""League-tagged model artifacts with hard cross-league load guards.

An artifact carries its league, market and exact feature schema. Persistence writes
a sidecar ``.meta.json`` next to the pickle so the guard can reject a mismatched
load **before** unpickling. Loading with the wrong league or market — or applying a
feature matrix whose width doesn't match the schema — raises
:class:`LeagueMismatchError`. This enforces the rule that MLB and NPB artifacts,
calibrators and evaluations never cross.

Artifacts are UNTRAINED/NotReady until a real dataset has been fitted (``trained``
is False and :meth:`predict_proba` raises). Nothing here fabricates performance.
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from ..errors import LeagueMismatchError, NotReady
from .profiles import BaseballMarket, League


@dataclass
class LeagueArtifact:
    league: League
    market: BaseballMarket
    feature_schema: tuple[str, ...]
    model: Any | None = None
    calibrator: Any | None = None
    trained: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    n_train: int = 0
    n_test: int = 0
    metrics: dict[str, float] = field(default_factory=dict)
    data_fingerprint: str | None = None
    is_synthetic: bool = False

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if not self.trained or self.model is None:
            raise NotReady(
                f"{self.league.value}/{self.market.value} artifact is UNTRAINED; "
                "ingest a real dataset and train before serving predictions."
            )
        X = np.asarray(X, dtype=float)
        if X.ndim != 2 or X.shape[1] != len(self.feature_schema):
            raise LeagueMismatchError(
                f"feature width {X.shape[-1] if X.ndim == 2 else X.shape} does not match "
                f"{self.league.value}/{self.market.value} schema of "
                f"{len(self.feature_schema)} columns {self.feature_schema}"
            )
        raw = np.asarray(self.model.predict_proba(X), dtype=float)
        if self.calibrator is not None:
            raw = np.asarray(self.calibrator.transform(raw), dtype=float)
        return np.clip(raw, 1e-6, 1 - 1e-6)

    # -- persistence ---------------------------------------------------------

    def _meta(self) -> dict[str, Any]:
        return {
            "league": self.league.value,
            "market": self.market.value,
            "feature_schema": list(self.feature_schema),
            "trained": self.trained,
            "created_at": self.created_at.isoformat(),
            "n_train": self.n_train,
            "n_test": self.n_test,
            "metrics": self.metrics,
            "data_fingerprint": self.data_fingerprint,
            "is_synthetic": self.is_synthetic,
        }

    def paths(self, base_dir: str | Path) -> tuple[Path, Path]:
        """Namespaced artifact + meta paths: ``{base}/{league}/{market}.pkl``."""
        d = Path(base_dir) / self.league.value
        return d / f"{self.market.value}.pkl", d / f"{self.market.value}.meta.json"

    def save(self, base_dir: str | Path) -> Path:
        pkl_path, meta_path = self.paths(base_dir)
        pkl_path.parent.mkdir(parents=True, exist_ok=True)
        meta_path.write_text(json.dumps(self._meta(), indent=2, sort_keys=True))
        with pkl_path.open("wb") as fh:
            pickle.dump(self, fh)
        return pkl_path


def _read_meta(base_dir: str | Path, league: League, market: BaseballMarket) -> dict[str, Any]:
    meta_path = Path(base_dir) / league.value / f"{market.value}.meta.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"no artifact metadata at {meta_path}")
    return json.loads(meta_path.read_text())


def load_artifact(
    base_dir: str | Path, *, expected_league: League, expected_market: BaseballMarket
) -> LeagueArtifact:
    """Load an artifact, refusing any league/market mismatch (guard first, then unpickle)."""
    meta = _read_meta(base_dir, expected_league, expected_market)
    if meta.get("league") != expected_league.value:
        raise LeagueMismatchError(
            f"artifact meta league {meta.get('league')!r} != expected {expected_league.value!r}"
        )
    if meta.get("market") != expected_market.value:
        raise LeagueMismatchError(
            f"artifact meta market {meta.get('market')!r} != expected {expected_market.value!r}"
        )
    pkl_path = Path(base_dir) / expected_league.value / f"{expected_market.value}.pkl"
    with pkl_path.open("rb") as fh:
        art = pickle.load(fh)
    if not isinstance(art, LeagueArtifact):
        raise LeagueMismatchError(f"unpickled object is not a LeagueArtifact: {type(art)!r}")
    if art.league != expected_league or art.market != expected_market:
        raise LeagueMismatchError(
            f"unpickled artifact {art.league.value}/{art.market.value} != expected "
            f"{expected_league.value}/{expected_market.value}"
        )
    return art
