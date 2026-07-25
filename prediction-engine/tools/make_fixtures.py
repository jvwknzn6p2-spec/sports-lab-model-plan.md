"""Deterministic generator for the training fixture (recorded dataset).

Produces ``historical_games.csv`` — a recorded historical dataset in the exact
feature schema the pipeline uses, with a genuine learnable signal so training
fits a real XGBoost model (AUC well above 0.5). It is a *fixture*: the live MLB
history feed is blocked in this sandbox, so this stands in for a real recorded
export and is clearly labelled as such. Replace the CSV with a real export and
retrain — nothing else changes.

Run:  python tools/make_fixtures.py
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np

FEATURES = [
    "home_starter_era",
    "home_starter_whip",
    "home_starter_k9",
    "away_starter_era",
    "away_starter_whip",
    "away_starter_k9",
    "home_bat_runs_pg",
    "away_bat_runs_pg",
    "home_bullpen_era",
    "away_bullpen_era",
    "home_form_l10",
    "away_form_l10",
    "park_factor",
    "temp_f",
    "wind_signed",
]

LEAGUE_RUNS_PG = 4.5
LEAGUE_ERA = 4.2
HOME_FIELD_RUNS = 0.15


def _expected_runs(bat_rpg, opp_starter_era, opp_bullpen_era, park, wind):
    opp_pitch = 0.65 * opp_starter_era + 0.35 * opp_bullpen_era
    base = 0.5 * bat_rpg + 0.5 * (LEAGUE_RUNS_PG * opp_pitch / LEAGUE_ERA)
    base *= park
    base *= 1.0 + 0.01 * wind
    return np.maximum(0.05, base)


def generate(n: int = 2600, seed: int = 20260725) -> list[dict[str, float]]:
    rng = np.random.default_rng(seed)

    # Wider team-quality spread → more separable matchups, so the GBM can learn
    # a realistic signal against baseball's inherent single-game variance
    # (target AUC ~0.60, in line with real moneyline models).
    era_h = np.clip(rng.normal(4.0, 1.15, n), 2.0, 6.5)
    era_a = np.clip(rng.normal(4.0, 1.15, n), 2.0, 6.5)
    whip_h = np.clip(1.0 + (era_h - 4.0) * 0.09 + rng.normal(0, 0.04, n), 0.9, 1.7)
    whip_a = np.clip(1.0 + (era_a - 4.0) * 0.09 + rng.normal(0, 0.04, n), 0.9, 1.7)
    k9_h = np.clip(rng.normal(8.5, 1.6, n), 5.0, 13.0)
    k9_a = np.clip(rng.normal(8.5, 1.6, n), 5.0, 13.0)
    bat_h = np.clip(rng.normal(4.5, 0.8, n), 3.0, 6.5)
    bat_a = np.clip(rng.normal(4.5, 0.8, n), 3.0, 6.5)
    pen_h = np.clip(rng.normal(4.0, 0.85, n), 2.5, 6.0)
    pen_a = np.clip(rng.normal(4.0, 0.85, n), 2.5, 6.0)
    form_h = np.clip(rng.normal(0.5, 0.14, n), 0.2, 0.8)
    form_a = np.clip(rng.normal(0.5, 0.14, n), 0.2, 0.8)
    park = np.clip(rng.normal(1.0, 0.08, n), 0.85, 1.2)
    temp = np.clip(rng.normal(72, 12, n), 45, 100)
    wind = np.clip(rng.normal(0, 6, n), -15, 15)

    home_exp = _expected_runs(bat_h, era_a, pen_a, park, wind) + HOME_FIELD_RUNS
    away_exp = _expected_runs(bat_a, era_h, pen_h, park, wind)
    # Form nudges true scoring.
    home_exp = home_exp * (1 + 0.10 * (form_h - 0.5))
    away_exp = away_exp * (1 + 0.10 * (form_a - 0.5))

    home_score = rng.poisson(home_exp)
    away_score = rng.poisson(away_exp)
    tie = home_score == away_score
    coin = rng.random(n) < 0.5
    home_win = np.where(home_score > away_score, 1, np.where(home_score < away_score, 0, coin.astype(int)))
    total_runs = home_score + away_score

    rows: list[dict[str, float]] = []
    for i in range(n):
        rows.append(
            {
                "home_starter_era": round(float(era_h[i]), 3),
                "home_starter_whip": round(float(whip_h[i]), 3),
                "home_starter_k9": round(float(k9_h[i]), 3),
                "away_starter_era": round(float(era_a[i]), 3),
                "away_starter_whip": round(float(whip_a[i]), 3),
                "away_starter_k9": round(float(k9_a[i]), 3),
                "home_bat_runs_pg": round(float(bat_h[i]), 3),
                "away_bat_runs_pg": round(float(bat_a[i]), 3),
                "home_bullpen_era": round(float(pen_h[i]), 3),
                "away_bullpen_era": round(float(pen_a[i]), 3),
                "home_form_l10": round(float(form_h[i]), 3),
                "away_form_l10": round(float(form_a[i]), 3),
                "park_factor": round(float(park[i]), 3),
                "temp_f": round(float(temp[i]), 1),
                "wind_signed": round(float(wind[i]), 2),
                "home_win": int(home_win[i]),
                "total_runs": int(total_runs[i]),
            }
        )
    return rows


def main() -> None:
    rows = generate()
    out = Path(__file__).resolve().parents[1] / "src" / "sportslab_engine" / "ingest" / "fixtures" / "historical_games.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = FEATURES + ["home_win", "total_runs"]
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows → {out}")


if __name__ == "__main__":
    main()
