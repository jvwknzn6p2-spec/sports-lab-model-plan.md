"""League API tests: /leagues discovery + cross-league artifact rejection."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from handiedge.config import get_settings
from handiedge.connector.models import Competitor, FixtureRecord, OddsSnapshotRow, ResultRecord
from handiedge.leagues.datasets import build_training_dataset
from handiedge.leagues.pipeline import train_market
from handiedge.leagues.profiles import MLB_PROFILE, BaseballMarket
from handiedge.service.api import create_app

BASE = datetime(2026, 4, 1, 23, 0, tzinfo=UTC)


def _train_mlb_moneyline(base_dir):
    snaps, results, fixtures = [], [], []
    for i in range(20):
        fx = FixtureRecord(
            fixture_id=f"mlb-fx-{i:03d}",
            game_id=None,
            league="mlb",
            start_time=BASE + timedelta(days=i),
            status="completed",
            is_live=False,
            has_odds=True,
            home=Competitor(team_id=f"h{i}", name=f"H{i}"),
            away=Competitor(team_id=f"a{i}", name=f"A{i}"),
        )
        fixtures.append(fx)
        pub = fx.start_time - timedelta(hours=1)
        ph, pa = (1.7, 2.2) if i % 2 == 0 else (2.2, 1.7)
        for book in ("draftkings", "fanduel"):
            for sel, price, tid in [("home", ph, fx.home.team_id), ("away", pa, fx.away.team_id)]:
                snaps.append(
                    OddsSnapshotRow(
                        fixture_id=fx.fixture_id,
                        league="mlb",
                        sportsbook=book,
                        market_id="moneyline",
                        selection=sel,
                        normalized_selection=sel,
                        price=price,
                        points=None,
                        published_at=pub,
                        captured_at=pub,
                        team_id=tid,
                    )
                )
        h, a = (6, 3) if i % 2 == 0 else (2, 5)
        results.append(
            ResultRecord(
                fixture_id=fx.fixture_id,
                league="mlb",
                home_score=h,
                away_score=a,
                status="completed",
                is_final=True,
            )
        )
    ds = build_training_dataset(
        MLB_PROFILE,
        BaseballMarket.MONEYLINE,
        snapshots=snaps,
        results=results,
        fixtures=fixtures,
        is_synthetic=True,
    )
    art = train_market(MLB_PROFILE, BaseballMarket.MONEYLINE, ds)
    art.save(base_dir)
    return ds


def _client(tmp_path):
    return TestClient(create_app(settings=get_settings(data_dir=str(tmp_path))))


def test_leagues_endpoint_lists_both():
    client = TestClient(create_app(settings=get_settings()))
    body = client.get("/leagues").json()
    leagues = {row["league"] for row in body["leagues"]}
    assert leagues == {"mlb", "npb"}


def test_unknown_league_is_400(tmp_path):
    resp = _client(tmp_path).post(
        "/leagues/kbo/predict", json={"market": "moneyline", "features": [[0.5, 0, 0, 2, 0]]}
    )
    assert resp.status_code == 400


def test_no_artifact_is_503(tmp_path):
    resp = _client(tmp_path).post(
        "/leagues/mlb/predict", json={"market": "moneyline", "features": [[0.5, 0, 0, 2, 0]]}
    )
    assert resp.status_code == 503


def test_trained_artifact_serves_predictions(tmp_path):
    ds = _train_mlb_moneyline(str(tmp_path / "artifacts"))
    rows = ds.X[:2].tolist()
    resp = _client(tmp_path).post(
        "/leagues/mlb/predict", json={"market": "moneyline", "features": rows}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["league"] == "mlb" and body["model_trained"] is True
    assert body["is_synthetic"] is True
    assert len(body["predictions"]) == 2
    assert "not a guarantee" in body["disclaimer"].lower()


def test_feature_width_mismatch_is_409(tmp_path):
    _train_mlb_moneyline(str(tmp_path / "artifacts"))
    resp = _client(tmp_path).post(
        "/leagues/mlb/predict",
        json={"market": "moneyline", "features": [[0.5, 0, 0, 2, 0, 0.1]]},  # 6 cols
    )
    assert resp.status_code == 409


def test_cross_league_misfiled_artifact_is_409(tmp_path):
    art_base = tmp_path / "artifacts"
    _train_mlb_moneyline(str(art_base))
    # Misfile MLB artifact under NPB namespace; meta still says league=mlb.
    (art_base / "npb").mkdir(parents=True, exist_ok=True)
    shutil.copy(art_base / "mlb" / "moneyline.pkl", art_base / "npb" / "moneyline.pkl")
    shutil.copy(art_base / "mlb" / "moneyline.meta.json", art_base / "npb" / "moneyline.meta.json")
    resp = _client(tmp_path).post(
        "/leagues/npb/predict", json={"market": "moneyline", "features": [[0.5, 0, 0, 2, 0, 0]]}
    )
    assert resp.status_code == 409
