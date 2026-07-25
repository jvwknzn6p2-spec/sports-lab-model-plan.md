"""League-specific trainable pipelines and prediction (audit categories 6, 7).

Each league+market trains an independent model on a **deterministic temporal**
split of a league-isolated :class:`Dataset`: the point estimator (dependency-free
:class:`LogisticRegression`) is fit on the train slice, an isotonic calibrator on
the disjoint validation slice, and Brier / log-loss are reported on the held-out
test slice. Nothing is shuffled; nothing crosses leagues.

Honesty rules enforced here:
- An empty dataset yields an **UNTRAINED** :class:`LeagueArtifact` (``trained`` is
  False, :meth:`LeagueArtifact.predict_proba` raises) — never a fabricated model.
- Metrics come only from real held-out rows; synthetic datasets carry the
  ``is_synthetic`` flag through to the artifact so no downstream code can quote
  their metrics as real performance.
- ``run_line`` is trainable only when the settlement label contract yields clean
  binary rows; if a caller asks to train a market with no usable labels the
  builder simply returns an empty (UNTRAINED) artifact rather than inventing rows.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

import numpy as np

from ..errors import NotReady, UnsupportedMarketError
from ..modeling.abstention import AbstainReason, AbstentionPolicy
from ..modeling.baselines import LogisticRegression, MarketImpliedBaseline, Model
from ..modeling.calibration import IsotonicCalibrator
from ..modeling.splits import temporal_train_val_test
from .artifacts import LeagueArtifact
from .datasets import Dataset
from .profiles import BaseballMarket, LeagueProfile

# Minimum clean binary rows before a fit is attempted; below this we stay UNTRAINED
# rather than pretend a 3-row model has learned anything.
_MIN_TRAIN_ROWS = 12


def _brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def _log_loss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def _fingerprint(ds: Dataset) -> str:
    """Deterministic content hash of the dataset (for artifact provenance)."""
    h = hashlib.sha256()
    h.update(ds.league.encode())
    h.update(ds.market.encode())
    h.update(np.ascontiguousarray(ds.X, dtype="float64").tobytes())
    h.update(np.ascontiguousarray(ds.y, dtype="float64").tobytes())
    h.update(np.ascontiguousarray(ds.times, dtype="float64").tobytes())
    return h.hexdigest()[:16]


def train_market(
    profile: LeagueProfile,
    market: BaseballMarket,
    dataset: Dataset,
    *,
    val_frac: float = 0.2,
    test_frac: float = 0.2,
) -> LeagueArtifact:
    """Train one league+market model on a deterministic temporal split.

    Returns an UNTRAINED artifact when there are too few clean rows to fit
    honestly. The feature schema, league tag and ``is_synthetic`` flag propagate
    into the artifact so cross-league loads and synthetic metrics are guarded.
    """
    if dataset.league != profile.opticodds_league_id:
        raise UnsupportedMarketError(
            f"dataset league {dataset.league!r} != profile {profile.opticodds_league_id!r}"
        )
    schema = profile.feature_names(market)
    if tuple(dataset.feature_names) != tuple(schema):
        raise UnsupportedMarketError(
            f"dataset schema {dataset.feature_names} != {profile.league.value}/"
            f"{market.value} schema {schema}"
        )

    if dataset.n < _MIN_TRAIN_ROWS:
        # Honest UNTRAINED artifact: not enough real labelled history yet.
        return LeagueArtifact(
            league=profile.league,
            market=market,
            feature_schema=schema,
            trained=False,
            n_train=0,
            n_test=0,
            data_fingerprint=_fingerprint(dataset) if dataset.n else None,
            is_synthetic=dataset.is_synthetic,
        )

    tr, va, te = temporal_train_val_test(dataset.n, val_frac=val_frac, test_frac=test_frac)
    if len(tr) == 0 or len(va) == 0 or len(te) == 0:
        return LeagueArtifact(
            league=profile.league,
            market=market,
            feature_schema=schema,
            trained=False,
            data_fingerprint=_fingerprint(dataset),
            is_synthetic=dataset.is_synthetic,
        )

    model = LogisticRegression()
    model.fit(dataset.X[tr], dataset.y[tr])

    calibrator = IsotonicCalibrator()
    raw_va = model.predict_proba(dataset.X[va])
    calibrator.fit(raw_va, dataset.y[va])

    raw_te = model.predict_proba(dataset.X[te])
    cal_te = calibrator.transform(raw_te)
    y_te = dataset.y[te]

    baseline = MarketImpliedBaseline(fair_prob_col=0)
    base_te = baseline.predict_proba(dataset.X[te])

    metrics = {
        "brier": _brier(cal_te, y_te),
        "log_loss": _log_loss(cal_te, y_te),
        "brier_uncalibrated": _brier(raw_te, y_te),
        "brier_market_baseline": _brier(base_te, y_te),
        "base_rate": float(np.mean(y_te)),
    }
    return LeagueArtifact(
        league=profile.league,
        market=market,
        feature_schema=schema,
        model=model,
        calibrator=calibrator,
        trained=True,
        n_train=int(len(tr)),
        n_test=int(len(te)),
        metrics=metrics,
        data_fingerprint=_fingerprint(dataset),
        is_synthetic=dataset.is_synthetic,
    )


@dataclass(frozen=True, slots=True)
class Prediction:
    league: str
    market: str
    prob: float  # calibrated P(side A / over covers)
    fair_prob: float  # market-implied fair probability (from features)
    edge: float  # prob - fair_prob
    abstain: bool
    abstain_reason: str | None
    is_synthetic: bool


class LeaguePredictor:
    """Serve calibrated probabilities with a first-class abstention decision.

    Wraps a trained :class:`LeagueArtifact` and the league's per-market
    :class:`AbstentionPolicy`. Refuses to serve from an UNTRAINED artifact.
    """

    def __init__(self, profile: LeagueProfile, artifact: LeagueArtifact) -> None:
        if artifact.league != profile.league or profile.league.value != artifact.league.value:
            raise UnsupportedMarketError("artifact/profile league mismatch")
        self._profile = profile
        self._artifact = artifact
        self._policy: AbstentionPolicy = profile.thresholds[artifact.market]
        try:
            self._fair_col = profile.feature_names(artifact.market).index(
                _FAIR_COL_BY_MARKET[artifact.market]
            )
        except (ValueError, KeyError) as exc:  # pragma: no cover - schema is fixed
            raise UnsupportedMarketError(
                f"no fair-prob feature for {artifact.market.value}"
            ) from exc

    @property
    def baseline(self) -> Model:
        return MarketImpliedBaseline(fair_prob_col=self._fair_col)

    def predict(self, X: np.ndarray, *, n_lines_seen: int = 1) -> list[Prediction]:
        if not self._artifact.trained:
            raise NotReady(
                f"{self._profile.league.value}/{self._artifact.market.value} artifact is "
                "UNTRAINED; ingest a real dataset and train before serving predictions."
            )
        X = np.asarray(X, dtype=float)
        probs = self._artifact.predict_proba(X)
        fair = np.clip(X[:, self._fair_col], 1e-6, 1 - 1e-6)
        out: list[Prediction] = []
        for i in range(X.shape[0]):
            p = float(probs[i])
            f = float(fair[i])
            edge = p - f
            reason = self._policy.evaluate(
                prob_a=p, edge=edge, n_lines_seen=n_lines_seen, n_core4_picks=0
            )
            out.append(
                Prediction(
                    league=self._profile.league.value,
                    market=self._artifact.market.value,
                    prob=p,
                    fair_prob=f,
                    edge=edge,
                    abstain=reason is not None,
                    abstain_reason=reason.value if isinstance(reason, AbstainReason) else None,
                    is_synthetic=self._artifact.is_synthetic,
                )
            )
        return out


# The devig fair-probability feature per market (column consulted for edge/baseline).
_FAIR_COL_BY_MARKET: dict[BaseballMarket, str] = {
    BaseballMarket.MONEYLINE: "devig_prob_home",
    BaseballMarket.RUN_LINE: "devig_prob_home_cover",
    BaseballMarket.TOTAL_RUNS: "devig_prob_over",
}
