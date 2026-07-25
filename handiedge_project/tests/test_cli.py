"""CLI tests: live-connector-unavailable honesty + offline build/train/evaluate."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from handiedge.cli import main
from handiedge.connector.models import Competitor, FixtureRecord, OddsSnapshotRow, ResultRecord
from handiedge.leagues.ingest import NormalizedStore, _with_snap_key

BASE = datetime(2026, 4, 1, 23, 0, tzinfo=UTC)


def _seed_normalized(data_dir: str, league: str, n: int = 20) -> None:
    norm = NormalizedStore(data_dir)
    fixtures, odds, results = [], [], []
    for i in range(n):
        fx = FixtureRecord(
            fixture_id=f"{league}-fx-{i:03d}",
            game_id=None,
            league=league,
            start_time=BASE + timedelta(days=i),
            status="completed",
            is_live=False,
            has_odds=True,
            home=Competitor(team_id=f"{league}-home-{i}", name=f"Home {i}"),
            away=Competitor(team_id=f"{league}-away-{i}", name=f"Away {i}"),
        )
        fixtures.append(fx)
        pub = fx.start_time - timedelta(hours=1)
        ph, pa = (1.7, 2.2) if i % 2 == 0 else (2.2, 1.7)
        for book in ("draftkings", "fanduel"):
            for sel, price, tid in [
                ("home", ph, fx.home.team_id),
                ("away", pa, fx.away.team_id),
            ]:
                odds.append(
                    _with_snap_key(
                        OddsSnapshotRow(
                            fixture_id=fx.fixture_id,
                            league=league,
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
                )
        h, a = (6, 3) if i % 2 == 0 else (2, 5)
        results.append(
            ResultRecord(
                fixture_id=fx.fixture_id,
                league=league,
                home_score=h,
                away_score=a,
                status="completed",
                is_final=True,
            )
        )
    norm.upsert(league=league, kind="fixtures", key_field="fixture_id", records=fixtures)
    # odds already dicts with _snap_key
    path = norm._path(league, "odds")  # noqa: SLF001 - test seeds the store directly
    path.write_text("\n".join(json.dumps(o, default=str) for o in odds) + "\n")
    norm.upsert(league=league, kind="results", key_field="fixture_id", records=results)


def test_sync_fixtures_reports_connector_unavailable(monkeypatch, tmp_path):
    monkeypatch.setenv("HANDIEDGE_DATA_DIR", str(tmp_path))
    # Point the binary at something guaranteed absent.
    monkeypatch.setenv("HANDIEDGE_EXTERNAL_TOOL_BIN", "definitely-not-real-xyz")
    code = main(["sync-fixtures", "--league", "mlb"])
    assert code == 4  # ConnectorUnavailable exit code, no fabricated fixtures


def test_offline_build_train_evaluate(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("HANDIEDGE_DATA_DIR", str(tmp_path))
    _seed_normalized(str(tmp_path), "mlb", 20)

    assert main(["build-dataset", "--league", "mlb", "--market", "moneyline", "--synthetic"]) == 0
    assert (tmp_path / "datasets" / "mlb" / "moneyline.npz").exists()

    assert main(["train", "--league", "mlb", "--market", "moneyline"]) == 0
    assert (tmp_path / "artifacts" / "mlb" / "moneyline.pkl").exists()
    meta = json.loads((tmp_path / "artifacts" / "mlb" / "moneyline.meta.json").read_text())
    assert meta["league"] == "mlb" and meta["trained"] is True
    assert meta["is_synthetic"] is True  # synthetic flag survives to the artifact

    assert main(["evaluate", "--league", "mlb", "--market", "moneyline"]) == 0
    out = capsys.readouterr().out
    assert "league=mlb" in out and "trained=True" in out


def test_unknown_league_errors(monkeypatch, tmp_path):
    monkeypatch.setenv("HANDIEDGE_DATA_DIR", str(tmp_path))
    assert main(["build-dataset", "--league", "kbo", "--market", "moneyline"]) == 1


def test_predict_offline(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("HANDIEDGE_DATA_DIR", str(tmp_path))
    _seed_normalized(str(tmp_path), "mlb", 20)
    main(["build-dataset", "--league", "mlb", "--market", "moneyline", "--synthetic"])
    main(["train", "--league", "mlb", "--market", "moneyline"])
    capsys.readouterr()  # clear
    feats = tmp_path / "feats.json"
    # A single MLB moneyline feature row (5 cols): devig, log ph, log pa, books, disp.
    feats.write_text(json.dumps([[0.6, 0.53, 0.79, 2.0, 0.01]]))
    assert (
        main(["predict", "--league", "mlb", "--market", "moneyline", "--features-json", str(feats)])
        == 0
    )
    out = capsys.readouterr().out
    assert "prob" in out and "abstain" in out
