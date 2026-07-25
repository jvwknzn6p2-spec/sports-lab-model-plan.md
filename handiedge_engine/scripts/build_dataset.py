"""Build a leakage-safe training dataset from real MLB history.

This is the one step that requires network access. Responses are cached under
``--cache-dir`` and the resulting dataset is written as JSONL, so every later
training run is fully reproducible **offline** from the exported file.

Usage:
    python scripts/build_dataset.py \
        --start 2023-04-01 --end 2023-09-30 \
        --out datasets/mlb_2023.jsonl

Then train against it without touching the network:
    python scripts/train_xgboost.py --source dataset --dataset datasets/mlb_2023.jsonl \
        --out artifacts/xgboost_mlb
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.domain.prediction.dataset import (  # noqa: E402
    AsOfDatasetBuilder,
    unsourced_features,
)
from app.domain.prediction.features import FEATURE_NAMES, FEATURE_VERSION  # noqa: E402
from app.infrastructure.data_sources.mlb_stats_api import MlbStatsApiFeed  # noqa: E402
from app.infrastructure.data_sources.odds import (  # noqa: E402
    CsvOddsHistory,
    TheOddsApiHistory,
)
from app.infrastructure.data_sources.weather import (  # noqa: E402
    OpenMeteoWeatherHistory,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", required=True, help="start date, YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="end date, YYYY-MM-DD")
    parser.add_argument("--out", required=True, help="output JSONL path")
    parser.add_argument("--cache-dir", default=".mlb_cache")
    parser.add_argument(
        "--skip-boxscores",
        action="store_true",
        help="schedule only (faster); starter/wOBA/bullpen features stay unavailable",
    )
    parser.add_argument(
        "--weather",
        action="store_true",
        help="enable temp_f/wind_mph via the Open-Meteo archive (free, no key)",
    )
    parser.add_argument(
        "--first-pitch-hour",
        type=int,
        default=19,
        help="local hour used to pick the game-time weather reading (default 19)",
    )
    parser.add_argument(
        "--odds-csv",
        help="CSV/JSONL of closing moneylines -> implied_home_win_probability",
    )
    parser.add_argument(
        "--odds-api",
        action="store_true",
        help="use The Odds API historical endpoint (requires ODDS_API_KEY)",
    )
    args = parser.parse_args()

    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)

    feed = MlbStatsApiFeed(cache_dir=args.cache_dir)
    print(f"[build-dataset] fetching schedule {start} .. {end}")
    games = feed.fetch_schedule(start, end)
    print(f"[build-dataset] {len(games)} completed games")
    if not games:
        raise SystemExit("no completed games in range; nothing to build")

    boxscores: dict = {}
    if not args.skip_boxscores:
        for i, game in enumerate(games, start=1):
            try:
                boxscores[game.game_pk] = feed.fetch_boxscore(game.game_pk)
            except Exception as exc:  # noqa: BLE001 - one bad game must not abort
                print(f"[build-dataset] WARN boxscore {game.game_pk} failed: {exc}")
            if i % 100 == 0:
                print(f"[build-dataset] boxscores {i}/{len(games)}")

    # --- optional external feeds (enable the remaining contract features) ----
    weather_lookup = None
    if args.weather:
        print("[build-dataset] enabling weather (Open-Meteo archive)")
        weather = OpenMeteoWeatherHistory(
            cache_dir=args.cache_dir,
            start=start,
            end=end,
            first_pitch_hour=args.first_pitch_hour,
        )

        def weather_lookup(game_date, venue_id):  # noqa: F811 - conditional binding
            observation = weather.lookup(game_date, venue_id)
            return observation.temp_f, observation.wind_mph

    odds_lookup = None
    if args.odds_csv and args.odds_api:
        raise SystemExit("use either --odds-csv or --odds-api, not both")
    if args.odds_csv:
        source = CsvOddsHistory(args.odds_csv)
        print(f"[build-dataset] enabling odds from {args.odds_csv} ({len(source)} rows)")
        odds_lookup = source.lookup
    elif args.odds_api:
        print("[build-dataset] enabling odds via The Odds API (ODDS_API_KEY)")
        odds_lookup = TheOddsApiHistory(cache_dir=args.cache_dir).lookup

    builder = AsOfDatasetBuilder(
        boxscore_lookup=lambda pk: boxscores.get(pk),
        weather_lookup=weather_lookup,
        odds_lookup=odds_lookup,
    )
    rows = builder.build(games)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row.to_json()) + "\n")

    usable = sum(1 for r in rows if any(v is not None for v in r.features))
    still_unsourced = unsourced_features(
        weather=weather_lookup is not None, odds=odds_lookup is not None
    )
    coverage = _coverage(rows)
    manifest = {
        "source": "mlb_stats_api",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "rows": len(rows),
        "rows_with_features": usable,
        "feature_version": FEATURE_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "unsourced_features": list(still_unsourced),
        "boxscores_fetched": len(boxscores),
        "weather_source": "open_meteo_archive" if weather_lookup else None,
        # Observed conditions are a mild optimistic assumption vs the forecast
        # available pre-game. Recorded so the provenance is auditable.
        "weather_mode": "observed" if weather_lookup else None,
        "odds_source": (
            "csv" if args.odds_csv else ("the_odds_api" if args.odds_api else None)
        ),
        "odds_devig": bool(odds_lookup),
        "feature_coverage": coverage,
    }
    manifest_path = out_path.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"[build-dataset] wrote {len(rows)} rows -> {out_path}")
    print(f"[build-dataset] {usable} rows have at least one derived feature")
    print(f"[build-dataset] manifest -> {manifest_path}")
    for name in FEATURE_NAMES:
        print(f"[build-dataset]   {name:32s} coverage {coverage[name]:6.1%}")
    if still_unsourced:
        print(f"[build-dataset] NOTE still unsourced: {list(still_unsourced)}")
    else:
        print("[build-dataset] all contract features sourced")


def _coverage(rows) -> dict:
    """Fraction of rows with a non-null value, per feature."""

    total = len(rows) or 1
    return {
        name: sum(1 for r in rows if r.features[i] is not None) / total
        for i, name in enumerate(FEATURE_NAMES)
    }


if __name__ == "__main__":
    main()
