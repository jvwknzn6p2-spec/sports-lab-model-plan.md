"""League-isolated training datasets via event-time / as-of joins (categories 4, 6).

Features come only from odds snapshots published at or before each fixture's start
(no in-play leakage). Labels come from completed results (never used as features).
Rows are ordered ascending by the as-of cutoff so downstream temporal splits are
valid. All inputs must belong to a single league; mixing raises
:class:`LeagueMismatchError`.

Real historical inputs are supplied by the operator; this module never manufactures
training rows. Synthetic inputs are permitted only in tests and must set
``is_synthetic=True`` (the flag propagates to the dataset and any artifact).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np

from ..connector.models import FixtureRecord, OddsSnapshotRow, ResultRecord
from ..domain.events import EventOutcome
from ..domain.settlement import settle
from ..domain.taxonomy import MarketType, SettlementResult, Side
from ..errors import LeagueMismatchError
from ..probability.implied import remove_vig
from .profiles import MARKET_TYPE, BaseballMarket, LeagueProfile

# Deterministic, documented per-league config priors used as model inputs. These are
# configuration constants (not observed data / not fabricated performance).
_NPB_TIE_PRIOR = 0.07
_NPB_TIE_ADJUST = 0.05
_NPB_LOW_SCORING_PRIOR = 0.60


@dataclass(frozen=True, slots=True)
class Dataset:
    league: str
    market: str
    feature_names: tuple[str, ...]
    X: np.ndarray
    y: np.ndarray
    times: np.ndarray  # epoch seconds of the as-of cutoff, ascending
    fixture_ids: list[str]
    is_synthetic: bool = False

    def __post_init__(self) -> None:
        n = self.X.shape[0]
        if not (len(self.y) == len(self.times) == len(self.fixture_ids) == n):
            raise ValueError("dataset arrays are ragged")
        if n and self.X.shape[1] != len(self.feature_names):
            raise ValueError(
                f"X has {self.X.shape[1]} cols but {len(self.feature_names)} feature names"
            )
        if n and np.any(np.diff(self.times.astype("float64")) < 0):
            raise ValueError("dataset rows must be sorted ascending by as-of time")

    @property
    def n(self) -> int:
        return int(self.X.shape[0])

    def save_npz(self, path: str) -> str:
        """Persist to a compressed ``.npz`` (feature names / ids kept as metadata)."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            p,
            league=self.league,
            market=self.market,
            feature_names=np.array(self.feature_names, dtype=object),
            X=self.X,
            y=self.y,
            times=self.times,
            fixture_ids=np.array(self.fixture_ids, dtype=object),
            is_synthetic=self.is_synthetic,
        )
        return str(p)

    @staticmethod
    def load_npz(path: str) -> Dataset:
        with np.load(path, allow_pickle=True) as z:
            return Dataset(
                league=str(z["league"]),
                market=str(z["market"]),
                feature_names=tuple(str(f) for f in z["feature_names"].tolist()),
                X=np.asarray(z["X"], dtype=float),
                y=np.asarray(z["y"], dtype=float),
                times=np.asarray(z["times"], dtype=float),
                fixture_ids=[str(f) for f in z["fixture_ids"].tolist()],
                is_synthetic=bool(z["is_synthetic"]),
            )


def _latest_per_book(
    rows: list[OddsSnapshotRow], cutoff: datetime, predicate
) -> dict[str, OddsSnapshotRow]:
    """Latest snapshot per sportsbook for a selection, on/before the cutoff."""
    best: dict[str, OddsSnapshotRow] = {}
    for r in rows:
        if r.published_at > cutoff or not predicate(r):
            continue
        cur = best.get(r.sportsbook)
        if cur is None or r.published_at > cur.published_at:
            best[r.sportsbook] = r
    return best


def _consensus(prices: list[float]) -> float:
    return float(np.median(np.asarray(prices, dtype=float)))


def _moneyline_features(
    profile: LeagueProfile, rows: list[OddsSnapshotRow], fx: FixtureRecord
) -> dict[str, float] | None:
    home = _latest_per_book(rows, fx.start_time, lambda r: r.team_id == fx.home.team_id)
    away = _latest_per_book(rows, fx.start_time, lambda r: r.team_id == fx.away.team_id)
    if not home or not away:
        return None
    ph = [r.price for r in home.values()]
    pa = [r.price for r in away.values()]
    ch, ca = _consensus(ph), _consensus(pa)
    fair = remove_vig([ch, ca], method="multiplicative")
    feats = {
        "devig_prob_home": fair.probabilities[0],
        "log_price_home": float(np.log(ch)),
        "log_price_away": float(np.log(ca)),
        "book_count": float(min(len(home), len(away))),
        "price_dispersion": float(np.std(ph)),
    }
    if profile.league.value == "npb":
        feats["npb_tie_prior"] = _NPB_TIE_PRIOR
    return feats


def _total_features(
    profile: LeagueProfile, rows: list[OddsSnapshotRow], fx: FixtureRecord
) -> dict[str, float] | None:
    over = _latest_per_book(rows, fx.start_time, lambda r: "over" in r.normalized_selection.lower())
    under = _latest_per_book(
        rows, fx.start_time, lambda r: "under" in r.normalized_selection.lower()
    )
    if not over or not under:
        return None
    po = [r.price for r in over.values()]
    pu = [r.price for r in under.values()]
    lines = [r.points for r in over.values() if r.points is not None]
    if not lines:
        return None
    co, cu = _consensus(po), _consensus(pu)
    fair = remove_vig([co, cu], method="multiplicative")
    feats = {
        "devig_prob_over": fair.probabilities[0],
        "total_line": _consensus(lines),
        "log_price_over": float(np.log(co)),
        "log_price_under": float(np.log(cu)),
        "book_count": float(min(len(over), len(under))),
    }
    if profile.league.value == "npb":
        feats["npb_low_scoring_prior"] = _NPB_LOW_SCORING_PRIOR
    return feats


def _run_line_features(
    profile: LeagueProfile, rows: list[OddsSnapshotRow], fx: FixtureRecord
) -> dict[str, float] | None:
    home = _latest_per_book(rows, fx.start_time, lambda r: r.team_id == fx.home.team_id)
    away = _latest_per_book(rows, fx.start_time, lambda r: r.team_id == fx.away.team_id)
    if not home or not away:
        return None
    ph = [r.price for r in home.values()]
    pa = [r.price for r in away.values()]
    pts = [r.points for r in home.values() if r.points is not None]
    ch, ca = _consensus(ph), _consensus(pa)
    fair = remove_vig([ch, ca], method="multiplicative")
    feats = {
        "devig_prob_home_cover": fair.probabilities[0],
        "run_line_points": _consensus(pts) if pts else -1.5,
        "log_price_home": float(np.log(ch)),
        "log_price_away": float(np.log(ca)),
        "book_count": float(min(len(home), len(away))),
    }
    if profile.league.value == "npb":
        feats["npb_tie_adjust"] = _NPB_TIE_ADJUST
    return feats


_FEATURE_FN = {
    BaseballMarket.MONEYLINE: _moneyline_features,
    BaseballMarket.TOTAL_RUNS: _total_features,
    BaseballMarket.RUN_LINE: _run_line_features,
}


def _label(
    profile: LeagueProfile,
    market: BaseballMarket,
    result: ResultRecord,
    feats: dict[str, float],
) -> float | None:
    """Derive a binary label via domain settlement; None => unlabelable (push/void/tie)."""
    if result.voided or result.home_score is None or result.away_score is None:
        return None
    outcome = EventOutcome(
        event_id=uuid.uuid4(),
        score_home=result.home_score,
        score_away=result.away_score,
        voided=result.voided,
    )
    market_type = MARKET_TYPE[market]
    rules = profile.settlement[market]
    if market_type is MarketType.MONEYLINE:
        settled = settle(outcome, market_type, Side.A, draw_allowed=rules.draw_allowed)
    elif market_type is MarketType.HANDICAP:
        settled = settle(outcome, market_type, Side.A, line=feats["run_line_points"])
    else:  # TOTAL
        settled = settle(outcome, market_type, Side.OVER, line=feats["total_line"])
    if settled.result is SettlementResult.WIN:
        return 1.0
    if settled.result is SettlementResult.LOSE:
        return 0.0
    return None  # PUSH / VOID / half -> not a clean binary training row


def build_training_dataset(
    profile: LeagueProfile,
    market: BaseballMarket,
    *,
    snapshots: list[OddsSnapshotRow],
    results: list[ResultRecord],
    fixtures: list[FixtureRecord],
    is_synthetic: bool = False,
) -> Dataset:
    league = profile.opticodds_league_id
    for coll, kind in ((snapshots, "snapshot"), (results, "result"), (fixtures, "fixture")):
        for item in coll:
            if item.league != league:
                raise LeagueMismatchError(
                    f"{kind} for league {item.league!r} passed to {league!r} dataset builder"
                )

    fx_by_id = {f.fixture_id: f for f in fixtures}
    res_by_id = {r.fixture_id: r for r in results}
    snaps_by_fx: dict[str, list[OddsSnapshotRow]] = {}
    for s in snapshots:
        if s.market_id == market.value:
            snaps_by_fx.setdefault(s.fixture_id, []).append(s)

    feature_names = profile.feature_names(market)
    fn = _FEATURE_FN[market]
    built: list[tuple[float, str, list[float], float]] = []
    for fid, rows in snaps_by_fx.items():
        fx = fx_by_id.get(fid)
        res = res_by_id.get(fid)
        if fx is None or res is None or not res.is_final:
            continue
        feats = fn(profile, rows, fx)
        if feats is None:
            continue
        label = _label(profile, market, res, feats)
        if label is None:
            continue
        vec = [feats[name] for name in feature_names]
        built.append((fx.start_time.timestamp(), fid, vec, label))

    built.sort(key=lambda t: t[0])
    if not built:
        return Dataset(
            league=league,
            market=market.value,
            feature_names=feature_names,
            X=np.empty((0, len(feature_names)), dtype=float),
            y=np.empty((0,), dtype=float),
            times=np.empty((0,), dtype=float),
            fixture_ids=[],
            is_synthetic=is_synthetic,
        )
    times = np.array([b[0] for b in built], dtype=float)
    X = np.array([b[2] for b in built], dtype=float)
    y = np.array([b[3] for b in built], dtype=float)
    return Dataset(
        league=league,
        market=market.value,
        feature_names=feature_names,
        X=X,
        y=y,
        times=times,
        fixture_ids=[b[1] for b in built],
        is_synthetic=is_synthetic,
    )
