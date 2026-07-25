"""League isolation, anti-leakage, temporal split, settlement and pipeline tests."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest

from handiedge.connector.models import Competitor, FixtureRecord, OddsSnapshotRow, ResultRecord
from handiedge.errors import LeagueMismatchError, NotReady, UnsupportedMarketError
from handiedge.leagues.artifacts import LeagueArtifact, load_artifact
from handiedge.leagues.datasets import build_training_dataset
from handiedge.leagues.pipeline import LeaguePredictor, train_market
from handiedge.leagues.profiles import (
    MLB_PROFILE,
    NPB_PROFILE,
    BaseballMarket,
    League,
    get_profile,
    parse_league,
)

BASE = datetime(2026, 4, 1, 23, 0, tzinfo=UTC)


def _fixture(league: str, i: int) -> FixtureRecord:
    return FixtureRecord(
        fixture_id=f"{league}-fx-{i:03d}",
        game_id=f"{league}-g-{i:03d}",
        league=league,
        start_time=BASE + timedelta(days=i),
        status="completed",
        is_live=False,
        has_odds=True,
        home=Competitor(team_id=f"{league}-home-{i}", name=f"Home {i}"),
        away=Competitor(team_id=f"{league}-away-{i}", name=f"Away {i}"),
    )


def _ml_snaps(league: str, i: int, ph: float, pa: float) -> list[OddsSnapshotRow]:
    fx = _fixture(league, i)
    pub = fx.start_time - timedelta(hours=1)
    rows = []
    for book, dh, da in [("draftkings", 0.0, 0.0), ("fanduel", 0.02, -0.02)]:
        rows.append(
            OddsSnapshotRow(
                fixture_id=fx.fixture_id,
                league=league,
                sportsbook=book,
                market_id="moneyline",
                selection="home",
                normalized_selection="home",
                price=ph + dh,
                points=None,
                published_at=pub,
                captured_at=pub,
                team_id=fx.home.team_id,
            )
        )
        rows.append(
            OddsSnapshotRow(
                fixture_id=fx.fixture_id,
                league=league,
                sportsbook=book,
                market_id="moneyline",
                selection="away",
                normalized_selection="away",
                price=pa + da,
                points=None,
                published_at=pub,
                captured_at=pub,
                team_id=fx.away.team_id,
            )
        )
    return rows


def _result(league: str, i: int, home: int, away: int) -> ResultRecord:
    return ResultRecord(
        fixture_id=f"{league}-fx-{i:03d}",
        league=league,
        home_score=home,
        away_score=away,
        status="completed",
        is_final=True,
    )


def _ml_dataset(league: str, n: int = 20):
    profile = get_profile(parse_league(league))
    snaps: list[OddsSnapshotRow] = []
    results: list[ResultRecord] = []
    fixtures: list[FixtureRecord] = []
    for i in range(n):
        # Favor home when priced short; alternate outcomes for both classes.
        ph, pa = (1.7, 2.2) if i % 2 == 0 else (2.2, 1.7)
        snaps += _ml_snaps(league, i, ph, pa)
        fixtures.append(_fixture(league, i))
        res = _result(league, i, 6, 3) if i % 2 == 0 else _result(league, i, 2, 5)
        results.append(res)
    ds = build_training_dataset(
        profile,
        BaseballMarket.MONEYLINE,
        snapshots=snaps,
        results=results,
        fixtures=fixtures,
        is_synthetic=True,
    )
    return profile, ds


# -- profiles / schema isolation --------------------------------------------


def test_profiles_have_distinct_schemas():
    for market in BaseballMarket:
        mlb = MLB_PROFILE.feature_names(market)
        npb = NPB_PROFILE.feature_names(market)
        assert len(npb) == len(mlb) + 1  # NPB carries one extra league-specific column
        assert npb[-1].startswith("npb_")
        assert mlb != npb


def test_settlement_rules_differ_between_leagues():
    # NPB two-way moneyline tie is a PUSH; MLB has no tie.
    assert NPB_PROFILE.settlement[BaseballMarket.MONEYLINE].tie_rule.value == "push"
    assert MLB_PROFILE.settlement[BaseballMarket.MONEYLINE].tie_rule.value == "none"


# -- dataset: isolation, anti-leakage, temporal ordering ---------------------


def test_build_rejects_mixed_leagues():
    profile = MLB_PROFILE
    snaps = _ml_snaps("npb", 0, 1.7, 2.2)  # wrong league snapshot
    with pytest.raises(LeagueMismatchError):
        build_training_dataset(
            profile,
            BaseballMarket.MONEYLINE,
            snapshots=snaps,
            results=[_result("mlb", 0, 6, 3)],
            fixtures=[_fixture("mlb", 0)],
        )


def test_dataset_is_time_sorted_and_labeled():
    _, ds = _ml_dataset("mlb", 20)
    assert ds.n == 20
    assert np.all(np.diff(ds.times) >= 0)  # ascending as-of cutoff
    assert set(np.unique(ds.y)).issubset({0.0, 1.0})
    assert set(ds.y.tolist()) == {0.0, 1.0}  # both classes present
    assert ds.feature_names == MLB_PROFILE.feature_names(BaseballMarket.MONEYLINE)


def test_anti_leakage_excludes_post_start_only_odds():
    profile = MLB_PROFILE
    fx = _fixture("mlb", 0)
    # All odds published AFTER first pitch -> no as-of features -> row excluded.
    late = fx.start_time + timedelta(hours=2)
    leaky = [
        OddsSnapshotRow(
            fixture_id=fx.fixture_id,
            league="mlb",
            sportsbook="draftkings",
            market_id="moneyline",
            selection=s,
            normalized_selection=s,
            price=1.9,
            points=None,
            published_at=late,
            captured_at=late,
            team_id=tid,
        )
        for s, tid in [("home", fx.home.team_id), ("away", fx.away.team_id)]
    ]
    ds = build_training_dataset(
        profile,
        BaseballMarket.MONEYLINE,
        snapshots=leaky,
        results=[_result("mlb", 0, 6, 3)],
        fixtures=[fx],
    )
    assert ds.n == 0  # leakage would have created a row; anti-leakage drops it


def test_npb_tie_is_unlabelable_and_dropped():
    profile = NPB_PROFILE
    snaps = _ml_snaps("npb", 0, 1.9, 1.9)
    ds = build_training_dataset(
        profile,
        BaseballMarket.MONEYLINE,
        snapshots=snaps,
        results=[_result("npb", 0, 4, 4)],
        fixtures=[_fixture("npb", 0)],
    )
    assert ds.n == 0  # NPB tie => PUSH => not a clean binary row


# -- artifacts: save/load + cross-league guard -------------------------------


def test_artifact_untrained_predict_raises(tmp_path):
    art = LeagueArtifact(
        league=League.MLB,
        market=BaseballMarket.MONEYLINE,
        feature_schema=MLB_PROFILE.feature_names(BaseballMarket.MONEYLINE),
    )
    assert art.trained is False
    with pytest.raises(NotReady):
        art.predict_proba(np.zeros((1, 5)))


def test_artifact_roundtrip_and_league_guard(tmp_path):
    profile, ds = _ml_dataset("mlb", 20)
    art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    assert art.trained is True
    base = tmp_path / "artifacts"
    art.save(base)
    loaded = load_artifact(
        base, expected_league=League.MLB, expected_market=BaseballMarket.MONEYLINE
    )
    assert loaded.trained and loaded.league is League.MLB

    # Misfile the MLB artifact under the NPB namespace (meta still says mlb): the
    # guard must reject it BEFORE unpickling.
    mlb_dir = base / "mlb"
    npb_dir = base / "npb"
    npb_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(mlb_dir / "moneyline.pkl", npb_dir / "moneyline.pkl")
    shutil.copy(mlb_dir / "moneyline.meta.json", npb_dir / "moneyline.meta.json")
    with pytest.raises(LeagueMismatchError):
        load_artifact(base, expected_league=League.NPB, expected_market=BaseballMarket.MONEYLINE)


def test_feature_width_mismatch_rejected(tmp_path):
    profile, ds = _ml_dataset("mlb", 20)
    art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    with pytest.raises(LeagueMismatchError):
        art.predict_proba(np.zeros((1, 6)))  # NPB-width matrix into MLB artifact


# -- pipeline: temporal split, UNTRAINED honesty, prediction -----------------


def test_train_empty_dataset_is_untrained():
    profile = MLB_PROFILE
    ds = build_training_dataset(
        profile, BaseballMarket.MONEYLINE, snapshots=[], results=[], fixtures=[]
    )
    art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    assert art.trained is False
    assert art.n_train == 0
    with pytest.raises(NotReady):
        art.predict_proba(np.zeros((1, 5)))


def test_train_reports_metrics_and_flags_synthetic():
    profile, ds = _ml_dataset("mlb", 20)
    art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    assert art.is_synthetic is True  # propagated so no one quotes synthetic metrics as real
    assert {"brier", "log_loss", "brier_market_baseline"}.issubset(art.metrics)
    assert 0.0 <= art.metrics["brier"] <= 1.0


def test_predictor_abstention_and_untrained_guard():
    profile, ds = _ml_dataset("mlb", 20)
    art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    predictor = LeaguePredictor(profile, art)
    preds = predictor.predict(ds.X[:3])
    assert len(preds) == 3
    assert all(p.league == "mlb" and p.market == "moneyline" for p in preds)
    assert all(isinstance(p.abstain, bool) for p in preds)

    untrained = LeagueArtifact(
        league=League.MLB,
        market=BaseballMarket.MONEYLINE,
        feature_schema=profile.feature_names(BaseballMarket.MONEYLINE),
    )
    with pytest.raises(NotReady):
        LeaguePredictor(profile, untrained).predict(ds.X[:1])


def test_predictor_rejects_cross_league_artifact():
    profile, ds = _ml_dataset("mlb", 20)
    mlb_art = train_market(profile, BaseballMarket.MONEYLINE, ds)
    with pytest.raises(UnsupportedMarketError):
        LeaguePredictor(NPB_PROFILE, mlb_art)  # MLB artifact under NPB profile


def test_train_rejects_schema_mismatch():
    profile, ds = _ml_dataset("mlb", 20)
    # Ask the NPB profile to train on an MLB dataset (schema width differs).
    with pytest.raises(UnsupportedMarketError):
        train_market(NPB_PROFILE, BaseballMarket.MONEYLINE, ds)
