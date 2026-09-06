"""Synthetic tests for scripts/evaluate_model.py — code validation only.

Nothing here says anything about the real models; the rows are made up so the
evaluator's behaviour (push handling, leak detection, duplicates, gate) can be
asserted exactly.
"""
from __future__ import annotations

import csv
import json
import random
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "evaluate_model.py"

FIELDS = [
    "event_id", "market_id", "sport", "league", "prediction_timestamp", "event_start_time",
    "candidate_prob", "baseline_prob", "actual_outcome", "settlement_result",
]


def write_csv(path: Path, rows: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in FIELDS})
    return path


def run(inp: Path, out: Path, *extra: str) -> tuple[int, dict]:
    p = subprocess.run(
        [sys.executable, str(SCRIPT), "--input", str(inp), "--output", str(out), "--bootstrap-samples", "300", *extra],
        capture_output=True, text=True,
    )
    return p.returncode, json.loads(out.read_text(encoding="utf-8"))


def synthetic_rows(n: int, seed: int, candidate_noise: float, baseline_noise: float) -> list[dict]:
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        truth = rng.uniform(0.2, 0.8)
        y = 1 if rng.random() < truth else 0
        c = min(max(truth + rng.gauss(0, candidate_noise), 0.01), 0.99)
        b = min(max(truth + rng.gauss(0, baseline_noise), 0.01), 0.99)
        rows.append({
            "event_id": f"E{i}", "market_id": "home", "sport": "baseball", "league": "MLB" if i % 2 else "NPB",
            "prediction_timestamp": "2026-08-01T10:00:00Z", "event_start_time": "2026-08-01T18:00:00Z",
            "candidate_prob": f"{c:.4f}", "baseline_prob": f"{b:.4f}", "actual_outcome": str(y),
        })
    return rows


def test_missing_input_is_not_run(tmp_path: Path):
    code, rep = run(tmp_path / "nope.csv", tmp_path / "out.json")
    assert code == 2
    assert rep["status"] == "NOT_RUN"
    assert rep["gate"]["passed"] is False


def test_push_rows_are_excluded_and_counted(tmp_path: Path):
    rows = synthetic_rows(40, 1, 0.05, 0.05)
    rows.append({
        "event_id": "PUSH1", "market_id": "home", "sport": "baseball", "league": "NPB",
        "prediction_timestamp": "2026-08-01T10:00:00Z", "event_start_time": "2026-08-01T18:00:00Z",
        "candidate_prob": "0.55", "baseline_prob": "0.5", "settlement_result": "PUSH",
    })
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 0, rep
    assert rep["counts"]["push_rows_excluded"] == 1
    assert rep["counts"]["scored_rows"] == 40
    # Below the gate minimum the comparison is descriptive only, never a fail.
    assert rep["status"] == "PASS"
    assert any("descriptive only" in r for r in rep["gate"]["reasons"])
    for key in ("brier", "log_loss", "ece_10bin", "accuracy_0_5"):
        assert key in rep["overall"]["candidate"]
    assert set(rep["segments"]["league"]) == {"MLB", "NPB"}


def test_prediction_at_or_after_start_invalidates(tmp_path: Path):
    rows = synthetic_rows(10, 2, 0.05, 0.05)
    rows[3]["prediction_timestamp"] = rows[3]["event_start_time"]  # exactly at start = leak
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 2
    assert rep["status"] == "INVALID"
    assert rep["data_integrity"]["prediction_at_or_after_start_rows"] == [5]  # csv line number (header = 1)
    assert rep["gate"]["passed"] is False


def test_duplicate_event_market_invalidates(tmp_path: Path):
    rows = synthetic_rows(10, 3, 0.05, 0.05)
    rows[4]["event_id"] = rows[2]["event_id"]
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 2
    assert rep["status"] == "INVALID"
    assert rep["data_integrity"]["duplicate_event_market_keys"] == [f"{rows[2]['event_id']}|home"]


def test_bad_probability_and_label_are_invalid_rows(tmp_path: Path):
    rows = synthetic_rows(6, 4, 0.05, 0.05)
    rows[0]["candidate_prob"] = "1.7"
    rows[1]["actual_outcome"] = "maybe"
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 2
    assert rep["counts"]["invalid_rows"] == 2
    assert rep["status"] == "INVALID"


def test_naive_timestamps_are_counted_not_silently_accepted(tmp_path: Path):
    rows = synthetic_rows(4, 5, 0.05, 0.05)
    rows[0]["prediction_timestamp"] = "2026-08-01T10:00:00"  # no zone
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert rep["data_integrity"]["naive_timestamp_fields"] == 1


def test_statistically_worse_candidate_regresses_above_gate_minimum(tmp_path: Path):
    # Candidate is pure noise around the truth; baseline is nearly exact.
    rows = synthetic_rows(600, 6, candidate_noise=0.25, baseline_noise=0.01)
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json", "--min-gate-samples", "200")
    assert code == 3
    assert rep["status"] == "REGRESSION"
    assert rep["gate"]["passed"] is False
    assert rep["overall"]["comparison"]["brier"]["ci95_low"] > 0


def test_equal_candidate_and_baseline_pass_with_zero_delta(tmp_path: Path):
    rows = synthetic_rows(300, 7, 0.05, 0.05)
    for r in rows:
        r["baseline_prob"] = r["candidate_prob"]
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json", "--min-gate-samples", "200")
    assert code == 0
    assert rep["status"] == "PASS"
    assert rep["overall"]["comparison"]["brier"]["delta_candidate_minus_baseline"] == 0


def test_partial_baseline_skips_comparison_with_warning(tmp_path: Path):
    rows = synthetic_rows(20, 8, 0.05, 0.05)
    rows[0]["baseline_prob"] = ""
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 0
    assert "comparison" not in rep["overall"]
    assert "partial baseline_prob" in rep["data_integrity"]["warning"]


def test_deterministic_given_seed(tmp_path: Path):
    rows = synthetic_rows(250, 9, 0.1, 0.1)
    inp = write_csv(tmp_path / "in.csv", rows)
    _, a = run(inp, tmp_path / "a.json", "--seed", "11")
    _, b = run(inp, tmp_path / "b.json", "--seed", "11")
    assert a["overall"]["comparison"] == b["overall"]["comparison"]


@pytest.mark.parametrize("label,expected", [("WIN", 1), ("LOSS", 0), ("W", 1), ("L", 0)])
def test_settlement_result_labels(tmp_path: Path, label: str, expected: int):
    rows = synthetic_rows(3, 10, 0.05, 0.05)
    rows[0]["actual_outcome"] = ""
    rows[0]["settlement_result"] = label
    rows[0]["candidate_prob"] = "0.9"
    code, rep = run(write_csv(tmp_path / "in.csv", rows), tmp_path / "out.json")
    assert code == 0
    # accuracy on that row: 0.9 >= 0.5 predicts WIN
    acc = rep["overall"]["candidate"]["accuracy_0_5"]
    assert 0 <= acc <= 1
    assert rep["counts"]["scored_rows"] == 3
