#!/usr/bin/env python3
"""Sample-size design for the calibration decision (.ai/CALIBRATION_EVAL_PLAN.md).

Reads an evaluation CSV (same columns as predictions_eval.csv) and reports,
from the DATA rather than from a summary:
  * the paired per-row Brier / log-loss differences (candidate − baseline),
    their variance, and the lag-1 autocorrelation of DAILY mean differences
    (time dependence that a row-wise CI ignores);
  * the design effect implied by date clusters;
  * the number of rows needed to detect a minimum improvement Δ at 80% power
    (two-sided α = 0.05) with the measured variance, with and without the
    design effect.
Nothing here decides anything; it feeds the pre-registered plan.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path

EPS = 1e-15


def brier(y, p):
    return (y - p) ** 2


def logloss(y, p):
    p = min(max(p, EPS), 1 - EPS)
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def stats(diffs, days):
    n = len(diffs)
    mean = sum(diffs) / n
    var = sum((d - mean) ** 2 for d in diffs) / (n - 1) if n > 1 else float("nan")
    by_day = defaultdict(list)
    for d, day in zip(diffs, days):
        by_day[day].append(d)
    keys = sorted(by_day)
    daily = [sum(by_day[k]) / len(by_day[k]) for k in keys]
    m = len(daily)
    rho = float("nan")
    if m > 2:
        mu = sum(daily) / m
        num = sum((daily[i] - mu) * (daily[i + 1] - mu) for i in range(m - 1))
        den = sum((x - mu) ** 2 for x in daily)
        rho = num / den if den > 0 else float("nan")
    # Design effect from clustering by day: 1 + (avg cluster size − 1) * ICC,
    # with ICC from a one-way ANOVA decomposition of the paired differences.
    sizes = [len(by_day[k]) for k in keys]
    avg = n / m
    if m > 1 and n > m:
        grand = mean
        ssb = sum(len(by_day[k]) * (sum(by_day[k]) / len(by_day[k]) - grand) ** 2 for k in keys)
        ssw = sum((d - sum(by_day[k]) / len(by_day[k])) ** 2 for k in keys for d in by_day[k])
        msb, msw = ssb / (m - 1), ssw / (n - m)
        n0 = (n - sum(s * s for s in sizes) / n) / (m - 1)
        icc = max(0.0, (msb - msw) / (msb + (n0 - 1) * msw)) if (msb + (n0 - 1) * msw) > 0 else 0.0
    else:
        icc = float("nan")
    deff = 1 + (avg - 1) * icc if not math.isnan(icc) else float("nan")
    return {"n": n, "days": m, "mean_diff": mean, "var_diff": var, "sd_diff": math.sqrt(var) if var == var else var,
            "lag1_autocorr_daily_mean": rho, "icc_by_day": icc, "design_effect": deff, "avg_rows_per_day": avg}


def n_required(var, delta, power=0.8, alpha=0.05, deff=1.0):
    z_a, z_b = 1.959964, 0.841621  # two-sided 5%, 80% power
    return math.ceil(deff * var * (z_a + z_b) ** 2 / (delta * delta))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="data/evaluation/predictions_eval.csv")
    ap.add_argument("--output", default="reports/calibration_power.json")
    ap.add_argument("--deltas", default="0.001,0.002,0.005", help="minimum improvements in mean Brier / log loss to detect")
    a = ap.parse_args(argv)
    rows = list(csv.DictReader(Path(a.input).open(encoding="utf-8", newline="")))
    out = {"input": a.input, "rows_scored": 0, "metrics": {}}
    yy, cc, bb, dd = [], [], [], []
    for r in rows:
        if (r.get("settlement_result") or "").upper() == "PUSH" or not r.get("baseline_prob"):
            continue
        yy.append(int(float(r["actual_outcome"])))
        cc.append(float(r["candidate_prob"]))
        bb.append(float(r["baseline_prob"]))
        dd.append(r.get("event_date") or r["event_start_time"][:10])
    out["rows_scored"] = len(yy)
    if len(yy) < 3:
        out["note"] = "fewer than 3 scored rows; nothing to estimate"
    else:
        for name, fn in (("brier", brier), ("log_loss", logloss)):
            diffs = [fn(y, c) - fn(y, b) for y, c, b in zip(yy, cc, bb)]
            s = stats(diffs, dd)
            req = {}
            for d in (float(x) for x in a.deltas.split(",")):
                req[str(d)] = {"rows_independent": n_required(s["var_diff"], d),
                               "rows_with_day_design_effect": n_required(s["var_diff"], d, deff=s["design_effect"]) if s["design_effect"] == s["design_effect"] else None}
            out["metrics"][name] = {**s, "rows_required_80pct_power_alpha05": req}
    Path(a.output).parent.mkdir(parents=True, exist_ok=True)
    Path(a.output).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
