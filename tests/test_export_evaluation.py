"""Tests for scripts/export_evaluation.py.

Two layers:
  * synthetic — a tiny fake repository in tmp_path pins the exporter's
    behaviour (settlement labels incl. PUSH, timestamp bounds, exclusions,
    soccer draws in the denominator, replay candidate join);
  * real-data smoke — the exporter runs over the committed ledgers of THIS
    repository and the evaluator must find the output valid (no leaks, no
    duplicates). This is the guard that keeps the CI evidence honest.
"""
from __future__ import annotations

import csv
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import evaluate_model as ev  # noqa: E402
import export_evaluation as ex  # noqa: E402


def _pred(pk: int, home: str, away: str, start: str, p_win: float, raw: float, winner: str | None, flags=(), **extra):
    d = {
        "gamePk": pk, "gameDate": start, "home": home, "away": away,
        "pass": winner is None, "predictedWinner": winner,
        "winProbability": p_win, "rawWinProbability": raw,
        "expectedRuns": {"home": 4.5, "away": 4.0},
        "flags": list(flags), "lockDeadline": "2026-08-10T13:59:00.000Z", "final": True,
    }
    d.update(extra)
    return d


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False))


def write_ndjson(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def fake_repo(root: Path) -> Path:
    mlb = root / "lib" / "sports-data" / "data"
    npb = root / "lib" / "sports-data" / "data-npb"

    # MLB slate: #1 in time (home favoured), #2 in time (away favoured), #3 PASS
    # and late but pre-start, #4 late and updatedAt is after first pitch →
    # excluded, #5 no result → excluded, #6 stored home probabilities + tie,
    # #7 carries its own predictedAt (new lock format).
    write_json(mlb / "predictions" / "2026-08-10.json", {
        "lockedAt": "2026-08-10T12:30:00.000Z",
        "updatedAt": "2026-08-10T17:30:00.000Z",
        "predictions": [
            _pred(1, "H1", "A1", "2026-08-10T17:05:00Z", 0.6, 0.62, "H1"),
            _pred(2, "H2", "A2", "2026-08-10T18:05:00Z", 0.55, 0.57, "A2"),
            _pred(3, "H3", "A3", "2026-08-10T23:05:00Z", 0.52, 0.51, None, flags=[ex.LATE_FLAG], expectedRuns={"home": 3.9, "away": 4.4}),
            _pred(4, "H4", "A4", "2026-08-10T17:00:00Z", 0.58, 0.6, "H4", flags=[ex.LATE_FLAG]),
            _pred(5, "H5", "A5", "2026-08-10T19:00:00Z", 0.58, 0.6, "H5"),
            _pred(6, "H6", "A6", "2026-08-10T20:00:00Z", 0.7, 0.66, "H6", homeWinProbability=0.7, rawHomeWinProbability=0.66),
            _pred(7, "H7", "A7", "2026-08-10T21:00:00Z", 0.6, 0.6, "H7", flags=[ex.LATE_FLAG], predictedAt="2026-08-10T14:20:00.000Z"),
        ],
    })
    write_json(mlb / "results" / "2026-08-10.json", {
        "date": "2026-08-10", "fetchedAt": "2026-08-11T05:00:00.000Z",
        "results": {"1": {"homeScore": 7, "awayScore": 6}, "2": {"homeScore": 2, "awayScore": 3},
                    "3": {"homeScore": 1, "awayScore": 4}, "4": {"homeScore": 5, "awayScore": 0},
                    "6": {"homeScore": 3, "awayScore": 3}, "7": {"homeScore": 2, "awayScore": 0}},
        "pending": [],
    })

    # NPB: one tie (push), one decided.
    write_json(npb / "predictions" / "2026-08-22.json", {
        "lockedAt": "2026-08-22T02:30:00.000Z", "updatedAt": "2026-08-22T08:00:00.000Z",
        "predictions": [
            _pred(9202608220101, "読売ジャイアンツ", "広島東洋カープ", "2026-08-22T09:00:00.000Z", 0.53, 0.54, None,
                  lockDeadline="2026-08-22T08:27:00.000Z", expectedRuns={"home": 3.5, "away": 3.2}),
            _pred(9202608220102, "阪神タイガース", "中日ドラゴンズ", "2026-08-22T09:00:00.000Z", 0.61, 0.63, "阪神タイガース",
                  lockDeadline="2026-08-22T08:27:00.000Z"),
        ],
    })
    write_json(npb / "results" / "2026-08-22.json", {
        "date": "2026-08-22", "fetchedAt": "2026-08-22T23:00:00.000Z",
        "results": {"9202608220101": {"homeScore": 2, "awayScore": 2}, "9202608220102": {"homeScore": 4, "awayScore": 1}},
        "pending": [], "cancelled": [],
    })

    # Soccer: two settled (one draw), one unsettled.
    L = root / "football" / "ledger"
    write_ndjson(L / "matches.ndjson", [
        {"providerId": "m1", "league": "E0", "kickoffAt": "2026-09-05T14:00:00Z", "cutoffAt": "2026-09-05T13:00:00.000Z", "home": "Arsenal", "away": "Chelsea", "recordedAt": "2026-09-03T01:00:00Z"},
        {"providerId": "m2", "league": "E0", "kickoffAt": "2026-09-05T16:30:00Z", "cutoffAt": "2026-09-05T15:30:00.000Z", "home": "Leeds", "away": "Everton", "recordedAt": "2026-09-03T01:00:00Z"},
        {"providerId": "m3", "league": "E0", "kickoffAt": "2026-09-06T15:00:00Z", "cutoffAt": "2026-09-06T14:00:00.000Z", "home": "Wolves", "away": "Fulham", "recordedAt": "2026-09-03T01:00:00Z"},
    ])
    write_ndjson(L / "predictions.ndjson", [
        {"id": "p1", "providerId": "m1", "league": "E0", "kickoffAt": "2026-09-05T14:00:00Z", "cutoffAt": "2026-09-05T13:00:00.000Z", "publishedAt": "2026-09-04T03:10:00.000Z", "model": "dc-v1", "pHome": 0.5, "pDraw": 0.25, "pAway": 0.25, "market": [0.45, 0.28, 0.27]},
        {"id": "p2", "providerId": "m2", "league": "E0", "kickoffAt": "2026-09-05T16:30:00Z", "cutoffAt": "2026-09-05T15:30:00.000Z", "publishedAt": "2026-09-04T03:10:00.000Z", "model": "dc-v1", "pHome": 0.4, "pDraw": 0.3, "pAway": 0.3, "market": None},
        {"id": "p3", "providerId": "m3", "league": "E0", "kickoffAt": "2026-09-06T15:00:00Z", "cutoffAt": "2026-09-06T14:00:00.000Z", "publishedAt": "2026-09-05T03:10:00.000Z", "model": "dc-v1", "pHome": 0.6, "pDraw": 0.2, "pAway": 0.2, "market": [0.5, 0.25, 0.25]},
    ])
    write_ndjson(L / "evaluations.ndjson", [
        {"predictionId": "p1", "providerId": "m1", "league": "E0", "result": "H", "homeGoals": 2, "awayGoals": 1, "rps": 0.1, "brier": 0.4, "logloss": 0.7, "marketRps": 0.12, "evaluatedAt": "2026-09-06T03:05:00.000Z"},
        {"predictionId": "p2", "providerId": "m2", "league": "E0", "result": "D", "homeGoals": 1, "awayGoals": 1, "rps": 0.1, "brier": 0.4, "logloss": 0.7, "marketRps": None, "evaluatedAt": "2026-09-06T03:05:00.000Z"},
    ])
    return root


def run_export(root: Path, *extra: str) -> tuple[dict[str, dict], dict]:
    """(rows keyed by event_id, manifest)."""
    out = root / "data" / "evaluation" / "predictions_eval.csv"
    man = root / "reports" / "evaluation_export.json"
    assert ex.main(["--root", str(root), "--output", str(out), "--manifest", str(man), *extra]) == 0
    with out.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    return {r["event_id"]: r for r in rows}, json.loads(man.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> tuple[dict[str, dict], dict]:
    """One export of the fake repository, shared by the read-only assertions."""
    return run_export(fake_repo(tmp_path_factory.mktemp("repo")))


def test_mlb_rows_are_home_axis_with_conservative_timestamps(exported):
    e, man = exported
    # In-time, home favoured: probabilities as stated, timestamp = deadline.
    r1 = e["MLB:1"]
    assert (r1["candidate_prob"], r1["baseline_prob"]) == ("0.6000", "0.6200")
    assert (r1["prediction_timestamp_basis"], r1["prediction_timestamp"]) == ("lock_deadline", "2026-08-10T13:59:00.000Z")
    assert (r1["actual_outcome"], r1["settlement_result"]) == ("1", "WIN")
    assert r1["settlement_rule"] == "MLB_FINAL_SCORE_INCL_EXTRA_INNINGS"
    # Away favoured: flipped to the home axis.
    r2 = e["MLB:2"]
    assert (r2["candidate_prob"], r2["baseline_prob"], r2["favored_side_basis"]) == ("0.4500", "0.4300", "predicted_winner")
    assert (r2["actual_outcome"], r2["settlement_result"]) == ("0", "LOSS")
    # PASS game, away expected to score more → side from expected runs, flagged as such.
    r3 = e["MLB:3"]
    assert (r3["favored_side_basis"], r3["candidate_prob"]) == ("expected_runs_fallback", "0.4800")
    assert (r3["predicted_after_deadline"], r3["prediction_timestamp_basis"]) == ("1", "lock_updated_at")
    # Stored home probabilities win over inference; a level score is a PUSH.
    r6 = e["MLB:6"]
    assert r6["favored_side_basis"] == "stored_home_probability"
    assert (r6["settlement_result"], r6["actual_outcome"]) == ("PUSH", "")
    # A pick with its own stamp uses it, even when flagged late.
    r7 = e["MLB:7"]
    assert (r7["prediction_timestamp_basis"], r7["prediction_timestamp"]) == ("predicted_at", "2026-08-10T14:20:00.000Z")
    # Late pick whose bound is after first pitch, and the game with no result, are gone.
    assert "MLB:4" not in e and "MLB:5" not in e
    assert man["counts"]["MLB"] == {
        "total": 7, "exported": 5, "exported_late_but_pre_start": 2, "push": 1,
        "excluded_prediction_bound_not_before_start": 1, "excluded_no_result": 1,
    }


def test_npb_tie_is_push_and_rule_is_stamped(exported):
    e, man = exported
    tie = e["NPB:9202608220101"]
    assert (tie["settlement_result"], tie["actual_outcome"]) == ("PUSH", "")
    assert tie["settlement_rule"] == "NPB_FINAL_POSTED_SCORE_TIE_PUSH"
    assert tie["prediction_timestamp"] == "2026-08-22T08:27:00.000Z"
    win = e["NPB:9202608220102"]
    assert (win["candidate_prob"], win["actual_outcome"]) == ("0.6100", "1")
    assert man["counts"]["NPB"]["push"] == 1


def test_soccer_draw_stays_in_denominator_and_unsettled_is_excluded(exported):
    e, man = exported
    d = e["SOCCER:m2"]
    assert (d["result_3way"], d["actual_outcome"], d["settlement_result"]) == ("D", "0", "LOSS")
    assert d["baseline_prob"] == ""  # no market captured → no baseline
    h = e["SOCCER:m1"]
    assert (h["candidate_prob"], h["baseline_prob"], h["actual_outcome"]) == ("0.5000", "0.4500", "1")
    assert h["prediction_timestamp"] == "2026-09-04T03:10:00.000Z"
    assert h["settlement_rule"].startswith("SOCCER_FULL_TIME_90")
    assert "SOCCER:m3" not in e
    assert man["counts"]["SOCCER"] == {"draws_in_denominator": 1, "excluded_no_result": 1, "exported": 2, "total": 3}


def test_replay_directory_becomes_candidate_and_lock_becomes_baseline(tmp_path: Path):
    root = fake_repo(tmp_path / "repo")
    replay = tmp_path / "replay"
    write_json(replay / "2026-08-10.json", {"predictions": [_pred(1, "H1", "A1", "2026-08-10T17:05:00Z", 0.66, 0.64, "H1")]})
    e, man = run_export(root, "--sports", "mlb", "--candidate-mlb-dir", str(replay))
    assert list(e) == ["MLB:1"]  # games without a replay row are excluded, not padded
    assert (e["MLB:1"]["candidate_prob"], e["MLB:1"]["baseline_prob"]) == ("0.6600", "0.6000")
    assert e["MLB:1"]["candidate_model"] == "replay_calibrated"
    assert man["candidate_source"]["MLB"] == "replay"
    assert man["counts"]["MLB"]["excluded_no_candidate_replay"] == 4


def test_legacy_lock_without_updated_at_excludes_late_picks(tmp_path: Path):
    root = fake_repo(tmp_path / "repo")
    lock_path = root / "lib" / "sports-data" / "data" / "predictions" / "2026-08-10.json"
    lock = json.loads(lock_path.read_text())
    del lock["updatedAt"]
    lock_path.write_text(json.dumps(lock))
    e, man = run_export(root, "--sports", "mlb")
    # Late picks with no stamp and no lock-level bound are unverifiable → out, counted.
    assert "MLB:3" not in e and "MLB:4" not in e
    assert man["counts"]["MLB"]["excluded_unverifiable_timestamp"] == 2
    # The pick carrying predictedAt does not need the lock-level bound.
    assert e["MLB:7"]["prediction_timestamp_basis"] == "predicted_at"


def test_output_is_deterministic(tmp_path: Path):
    root = fake_repo(tmp_path / "repo")
    assert run_export(root) == run_export(root)


def test_real_repository_export_is_valid_for_the_evaluator(tmp_path: Path):
    """Real-data smoke: the committed ledgers must export without leaks or duplicates.

    In the audit workflow the export already exists (EVAL_CSV points at it), so
    the same file is validated rather than regenerated.
    """
    csv_path = Path(os.environ["EVAL_CSV"]) if os.environ.get("EVAL_CSV") else None
    if csv_path is None or not csv_path.exists():
        csv_path = tmp_path / "predictions_eval.csv"
        assert ex.main(["--root", str(ROOT), "--output", str(csv_path), "--manifest", str(tmp_path / "manifest.json")]) == 0
    rep_path = tmp_path / "latest_evaluation.json"
    code = ev.main(["--input", str(csv_path), "--output", str(rep_path), "--bootstrap-samples", "200"])
    rep = json.loads(rep_path.read_text(encoding="utf-8"))
    assert rep["counts"]["scored_rows"] >= 1, rep["gate"]
    assert rep["status"] in {"PASS", "REGRESSION"}, rep["gate"]
    assert rep["data_integrity"]["prediction_at_or_after_start_rows"] == []
    assert rep["data_integrity"]["duplicate_event_market_keys"] == []
    assert rep["data_integrity"]["errors"] == []
    assert rep["data_integrity"]["naive_timestamp_fields"] == 0
    assert code in (0, 3)
