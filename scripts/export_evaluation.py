#!/usr/bin/env python3
"""Export the stored prediction/result record into data/evaluation/predictions_eval.csv.

Reads ONLY what the repository already commits (no network, no fabrication):

  MLB    lib/sports-data/data/predictions/<date>.json  + data/results/<date>.json
  NPB    lib/sports-data/data-npb/predictions/<date>.json + data-npb/results/<date>.json
  Soccer football/ledger/{matches,predictions,evaluations}.ndjson

One row per (event, market). The market is always the HOME side so every
game — PASS games included — sits on one fixed axis:

  candidate_prob   P(home wins)            baseline_prob  P(home wins) from the baseline
  actual_outcome   1 home won / 0 home did not win (soccer: draw counts as 0 and stays in)
  settlement_result WIN / LOSS / PUSH      (PUSH = level baseball score; excluded from scoring)

Timestamps (see .ai/ASTRA_REVIEW_POLICY.md, Appendix A.2): `prediction_timestamp`
is the pick's own `predictedAt` stamp when the lock has one, else the LATEST
instant the pick could still have changed — never earlier than the truth — so
a leak check against `event_start_time` is conservative.

A manifest with per-sport counts and every exclusion reason is written next to
the CSV (default reports/evaluation_export.json). Nothing is guessed: a game
without a stored result is excluded and counted.
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0"
LATE_FLAG = "[warn] predicted_after_deadline"

COLUMNS = [
    "sport",
    "league",
    "event_id",
    "market_id",
    "home",
    "away",
    "event_start_time",
    "prediction_timestamp",
    "prediction_timestamp_basis",
    "predicted_after_deadline",
    "lock_deadline",
    "candidate_prob",
    "candidate_model",
    "baseline_prob",
    "baseline_model",
    "favored_side_basis",
    "home_score",
    "away_score",
    "actual_outcome",
    "settlement_result",
    "settlement_rule",
    "result_source",
    "result_fetched_at",
    "p_draw",
    "p_away",
    "result_3way",
]

SETTLEMENT_RULES = {
    "MLB": "MLB_FINAL_SCORE_INCL_EXTRA_INNINGS",
    # npb.jp's month page posts the final score (up to the 12th inning); a tie is a push.
    # This is the repository's current basis — see policy Appendix A.3.
    "NPB": "NPB_FINAL_POSTED_SCORE_TIE_PUSH",
    "SOCCER": "SOCCER_FULL_TIME_90_PLUS_STOPPAGE_NO_ET_NO_PENS",
}

# league -> (store directory under lib/sports-data, result source)
BASEBALL = {
    "MLB": ("data", "statsapi.mlb.com"),
    "NPB": ("data-npb", "npb.jp"),
}

EXCLUSION_REASONS = {
    "excluded_no_result": "no stored final score for the game (pending, cancelled, or never fetched)",
    "excluded_no_start_time": "the prediction carries no event start time",
    "excluded_unverifiable_timestamp": (
        "late pick in a legacy lock (no predictedAt, no updatedAt): nothing in the record bounds "
        "when it was produced"
    ),
    "excluded_prediction_bound_not_before_start": (
        "the latest VERIFIABLE bound of the pick's production time is not before first pitch; "
        "the pick may have been made earlier but that cannot be shown from the record, so it is "
        "excluded fail-closed"
    ),
    "excluded_no_candidate_replay": "replay directory given but has no row for this game",
}


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        raise ValueError(f"naive timestamp: {s}")
    return d.astimezone(timezone.utc)


def iso(d: datetime | None) -> str:
    return "" if d is None else d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def fmt(p: float | None) -> str:
    return "" if p is None else f"{p:.4f}"


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def under(root: Path, p: str) -> Path:
    q = Path(p)
    return q if q.is_absolute() else root / q


# ---------------------------------------------------------------- baseball


def home_probabilities(p: dict[str, Any]) -> tuple[float, float, str]:
    """(calibrated P(home), raw P(home), basis).

    Locks written since the exporter exists carry `homeWinProbability` directly.
    Older locks only state the FAVOURED side's probability, so the side is
    recovered from `predictedWinner` (exact) or, for PASS games, from expected
    runs (the simulator's favourite; documented as a fallback).
    """
    if p.get("homeWinProbability") is not None and p.get("rawHomeWinProbability") is not None:
        return float(p["homeWinProbability"]), float(p["rawHomeWinProbability"]), "stored_home_probability"
    cal = float(p["winProbability"])
    raw = float(p["rawWinProbability"])
    winner = p.get("predictedWinner")
    if winner:
        home_fav = winner == p["home"]
        basis = "predicted_winner"
    else:
        er = p.get("expectedRuns") or {}
        home_fav = float(er.get("home", 0)) >= float(er.get("away", 0))
        basis = "expected_runs_fallback"
    return (cal if home_fav else 1 - cal), (raw if home_fav else 1 - raw), basis


def prediction_timestamp(lock: dict[str, Any], p: dict[str, Any]) -> tuple[datetime | None, str, int]:
    """When the pick was made: its own stamp, else a conservative upper bound."""
    late = int(LATE_FLAG in (p.get("flags") or []))
    if p.get("predictedAt"):
        return parse_ts(p["predictedAt"]), "predicted_at", late
    # Legacy locks (before predictedAt): a pick made in time was frozen at its
    # deadline; a late pick was produced by some later run, no later than the
    # lock's last update — and without `updatedAt` nothing bounds it at all.
    if not late:
        return parse_ts(p.get("lockDeadline") or lock.get("updatedAt") or lock.get("lockedAt")), "lock_deadline", late
    if lock.get("updatedAt"):
        return parse_ts(lock["updatedAt"]), "lock_updated_at", late
    return None, "unverifiable", late


def export_baseball(league: str, sd: Path, candidate_dir: Path | None, counts: Counter) -> list[dict[str, str]]:
    store, source = BASEBALL[league]
    pred_dir = sd / store / "predictions"
    results_dir = sd / store / "results"
    rows: list[dict[str, str]] = []
    if not pred_dir.is_dir():
        counts["missing_prediction_dir"] += 1
        return rows
    for lock_path in sorted(pred_dir.glob("*.json")):
        date = lock_path.stem
        lock = read_json(lock_path)
        results_path = results_dir / f"{date}.json"
        results = read_json(results_path) if results_path.exists() else {}
        result_map = results.get("results") or {}
        fetched_at = results.get("fetchedAt") or ""
        cand_by_pk: dict[str, dict[str, Any]] = {}
        if candidate_dir is not None and (candidate_dir / f"{date}.json").exists():
            cand_by_pk = {str(c["gamePk"]): c for c in read_json(candidate_dir / f"{date}.json").get("predictions", [])}

        for p in lock.get("predictions", []):
            counts["total"] += 1
            pk = str(p["gamePk"])
            r = result_map.get(pk)
            if r is None:
                counts["excluded_no_result"] += 1
                continue
            start = parse_ts(p.get("gameDate"))
            if start is None:
                counts["excluded_no_start_time"] += 1
                continue
            ts, basis, late = prediction_timestamp(lock, p)
            if ts is None:
                counts["excluded_unverifiable_timestamp"] += 1
                continue
            if ts >= start:
                counts["excluded_prediction_bound_not_before_start"] += 1
                continue

            prod_cal, prod_raw, side_basis = home_probabilities(p)
            if candidate_dir is not None:
                c = cand_by_pk.get(pk)
                if c is None:
                    counts["excluded_no_candidate_replay"] += 1
                    continue
                cand, _, cand_basis = home_probabilities(c)
                base = prod_cal
                cand_model, base_model = "replay_calibrated", "production_lock_calibrated"
                side_basis = f"{side_basis}/{cand_basis}"
            else:
                cand, base = prod_cal, prod_raw
                cand_model, base_model = "production_lock_calibrated", "production_lock_raw"

            hs, as_ = int(r["homeScore"]), int(r["awayScore"])
            if hs == as_:
                outcome, settled = "", "PUSH"
                counts["push"] += 1
            else:
                outcome, settled = ("1", "WIN") if hs > as_ else ("0", "LOSS")
            counts["exported"] += 1
            counts["exported_late_but_pre_start"] += late
            rows.append(
                {
                    "sport": "baseball",
                    "league": league,
                    "event_id": f"{league}:{pk}",
                    "market_id": "home_moneyline",
                    "home": p["home"],
                    "away": p["away"],
                    "event_start_time": iso(start),
                    "prediction_timestamp": iso(ts),
                    "prediction_timestamp_basis": basis,
                    "predicted_after_deadline": str(late),
                    "lock_deadline": p.get("lockDeadline") or "",
                    "candidate_prob": fmt(cand),
                    "candidate_model": cand_model,
                    "baseline_prob": fmt(base),
                    "baseline_model": base_model,
                    "favored_side_basis": side_basis,
                    "home_score": str(hs),
                    "away_score": str(as_),
                    "actual_outcome": outcome,
                    "settlement_result": settled,
                    "settlement_rule": SETTLEMENT_RULES[league],
                    "result_source": source,
                    "result_fetched_at": fetched_at,
                    "p_draw": "",
                    "p_away": "",
                    "result_3way": "",
                }
            )
    return rows


# ------------------------------------------------------------------ soccer


def export_soccer(ledger_dir: Path, counts: Counter) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    pred_path = ledger_dir / "predictions.ndjson"
    if not pred_path.exists():
        counts["missing_prediction_dir"] += 1
        return rows
    evals = {e["predictionId"]: e for e in read_ndjson(ledger_dir / "evaluations.ndjson")}
    matches = {m["providerId"]: m for m in read_ndjson(ledger_dir / "matches.ndjson")}  # last row wins
    for p in read_ndjson(pred_path):
        counts["total"] += 1
        e = evals.get(p["id"])
        if e is None:
            counts["excluded_no_result"] += 1
            continue
        start = parse_ts(p.get("kickoffAt"))
        ts = parse_ts(p.get("publishedAt"))
        if start is None or ts is None:
            counts["excluded_no_start_time"] += 1
            continue
        if ts >= start:
            counts["excluded_prediction_bound_not_before_start"] += 1
            continue
        m = matches.get(p["providerId"], {})
        market = p.get("market")
        base = float(market[0]) if isinstance(market, list) and len(market) == 3 else None
        res = e["result"]
        counts["exported"] += 1
        counts["draws_in_denominator"] += res == "D"
        rows.append(
            {
                "sport": "soccer",
                "league": p["league"],
                "event_id": f"SOCCER:{p['providerId']}",
                "market_id": "home_win_3way_projection",
                "home": m.get("home", ""),
                "away": m.get("away", ""),
                "event_start_time": iso(start),
                "prediction_timestamp": iso(ts),
                "prediction_timestamp_basis": "published_at",
                "predicted_after_deadline": "0",
                "lock_deadline": p.get("cutoffAt") or "",
                "candidate_prob": fmt(float(p["pHome"])),
                "candidate_model": str(p.get("model") or ""),
                "baseline_prob": fmt(base),
                "baseline_model": "market_implied_normalised" if base is not None else "",
                "favored_side_basis": "stored_home_probability",
                "home_score": str(e["homeGoals"]),
                "away_score": str(e["awayGoals"]),
                "actual_outcome": "1" if res == "H" else "0",
                "settlement_result": "WIN" if res == "H" else "LOSS",
                "settlement_rule": SETTLEMENT_RULES["SOCCER"],
                "result_source": "football-data.co.uk",
                "result_fetched_at": e.get("evaluatedAt") or "",
                "p_draw": fmt(float(p["pDraw"])),
                "p_away": fmt(float(p["pAway"])),
                "result_3way": res,
            }
        )
    return rows


# -------------------------------------------------------------------- main


def git_head(root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:  # noqa: BLE001 — provenance only
        return ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent), help="repository root")
    ap.add_argument("--output", default="data/evaluation/predictions_eval.csv")
    ap.add_argument("--manifest", default="reports/evaluation_export.json")
    ap.add_argument("--sports", default="mlb,npb,soccer", help="comma-separated subset of mlb,npb,soccer")
    ap.add_argument("--candidate-mlb-dir", help="directory of replayed MLB lock files (candidate); the stored lock becomes the baseline")
    ap.add_argument("--candidate-npb-dir", help="directory of replayed NPB lock files (candidate)")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    out = under(root, a.output)
    manifest_path = under(root, a.manifest)
    sports = {s.strip().upper() for s in a.sports.split(",") if s.strip()}
    candidate_dirs = {"MLB": a.candidate_mlb_dir, "NPB": a.candidate_npb_dir}

    rows: list[dict[str, str]] = []
    per_sport: dict[str, Counter] = {}
    for league in BASEBALL:
        if league in sports:
            per_sport[league] = Counter()
            cand = candidate_dirs[league]
            rows += export_baseball(league, root / "lib" / "sports-data", Path(cand) if cand else None, per_sport[league])
    if "SOCCER" in sports:
        per_sport["SOCCER"] = Counter()
        rows += export_soccer(root / "football" / "ledger", per_sport["SOCCER"])

    rows.sort(key=lambda r: (r["sport"], r["league"], r["event_start_time"], r["event_id"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "generated_from_commit": git_head(root),
        "output": str(out.relative_to(root)) if out.is_relative_to(root) else str(out),
        "rows": len(rows),
        "candidate_source": {
            **{lg: ("replay" if candidate_dirs[lg] else "production_lock_calibrated_vs_raw") for lg in BASEBALL},
            "SOCCER": "ledger_pHome_vs_market",
        },
        "settlement_rules": SETTLEMENT_RULES,
        "counts": {k: dict(sorted(v.items())) for k, v in per_sport.items()},
        "exclusion_reasons": EXCLUSION_REASONS,
        "timestamp_policy": (
            "prediction_timestamp is the pick's predictedAt stamp when present, else an upper bound of when "
            "the pick was last (re)computed (.ai/ASTRA_REVIEW_POLICY.md Appendix A.2); the true time is never "
            "later than the exported one"
        ),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
