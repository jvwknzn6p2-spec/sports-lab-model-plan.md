"""Error Analysis Engine (Component 6).

Consumes settled predictions (graded against actual results by the Settlement
engine) and measures how the system actually performed: moneyline accuracy
overall and by confidence rank, total (over/under) hit rate, probability
calibration (expected calibration error), the Brier score, realized betting ROI,
and an over/under-confidence signal. Its output is the evidence the Self-Learning
engine acts on.
"""

from __future__ import annotations

from typing import Any


def _safe_div(num: float, den: float) -> float:
    return num / den if den else 0.0


def _calibration(records: list[dict[str, Any]], bins: int = 5) -> dict[str, Any]:
    """Expected calibration error on P(home win) vs. actual home wins."""
    buckets: list[dict[str, float]] = [
        {"lo": i / bins, "hi": (i + 1) / bins, "sum_p": 0.0, "sum_y": 0.0, "n": 0.0}
        for i in range(bins)
    ]
    for r in records:
        p = float(r["homeWinProb"])
        y = 1.0 if r["actualHomeWin"] else 0.0
        idx = min(bins - 1, int(p * bins))
        buckets[idx]["sum_p"] += p
        buckets[idx]["sum_y"] += y
        buckets[idx]["n"] += 1

    total = len(records)
    ece = 0.0
    out_bins = []
    for b in buckets:
        n = b["n"]
        if n == 0:
            continue
        pred = b["sum_p"] / n
        actual = b["sum_y"] / n
        ece += (n / total) * abs(pred - actual)
        out_bins.append(
            {
                "pMid": round((b["lo"] + b["hi"]) / 2, 3),
                "predicted": round(pred, 4),
                "actual": round(actual, 4),
                "n": int(n),
            }
        )
    return {"ece": round(ece, 4), "bins": out_bins}


def analyze(settled: dict[str, Any]) -> dict[str, Any]:
    records: list[dict[str, Any]] = settled["settled"]
    n = len(records)
    if n == 0:
        return {"date": settled.get("date"), "n": 0, "note": "no settled records"}

    ml_correct = sum(1 for r in records if r["moneylineCorrect"])
    total_correct = sum(1 for r in records if r.get("totalCorrect"))

    by_conf: dict[str, dict[str, Any]] = {}
    for rank in ("S", "A", "B", "C"):
        subset = [r for r in records if r.get("finalConfidence") == rank]
        if subset:
            hits = sum(1 for r in subset if r["moneylineCorrect"])
            by_conf[rank] = {"n": len(subset), "accuracy": round(_safe_div(hits, len(subset)), 4)}

    # Brier score on P(home win).
    brier = sum(
        (float(r["homeWinProb"]) - (1.0 if r["actualHomeWin"] else 0.0)) ** 2 for r in records
    ) / n

    # Over/under-confidence: mean(pick probability − realized win) on the pick.
    conf_signal = 0.0
    for r in records:
        pick_prob = (
            float(r["homeWinProb"])
            if r["moneylinePick"] == "home"
            else 1 - float(r["homeWinProb"])
        )
        realized = 1.0 if r["moneylineCorrect"] else 0.0
        conf_signal += pick_prob - realized
    conf_signal /= n

    # Realized betting ROI on flagged positive-EV bets.
    staked = 0.0
    returned = 0.0
    pos_bets = 0
    for r in records:
        for bet in r.get("evBets", []):
            if bet.get("positive"):
                pos_bets += 1
                staked += 1.0
                returned += float(bet.get("profit", 0.0))

    return {
        "date": settled.get("date"),
        "n": n,
        "moneyline": {
            "accuracy": round(_safe_div(ml_correct, n), 4),
            "byConfidence": by_conf,
        },
        "total": {"accuracy": round(_safe_div(total_correct, n), 4)},
        "calibration": _calibration(records),
        "brier": round(brier, 4),
        "overconfidenceSignal": round(conf_signal, 4),
        "ev": {
            "positiveBets": pos_bets,
            "unitsStaked": round(staked, 3),
            "unitsReturned": round(returned, 3),
            "roi": round(_safe_div(returned, staked), 4),
        },
    }
