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
    UNSOURCED_FEATURES,
    AsOfDatasetBuilder,
)
from app.domain.prediction.features import FEATURE_NAMES, FEATURE_VERSION  # noqa: E402
from app.infrastructure.data_sources.mlb_stats_api import MlbStatsApiFeed  # noqa: E402


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

    builder = AsOfDatasetBuilder(boxscore_lookup=lambda pk: boxscores.get(pk))
    rows = builder.build(games)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row.to_json()) + "\n")

    usable = sum(1 for r in rows if any(v is not None for v in r.features))
    manifest = {
        "source": "mlb_stats_api",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "rows": len(rows),
        "rows_with_features": usable,
        "feature_version": FEATURE_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "unsourced_features": list(UNSOURCED_FEATURES),
        "boxscores_fetched": len(boxscores),
    }
    manifest_path = out_path.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"[build-dataset] wrote {len(rows)} rows -> {out_path}")
    print(f"[build-dataset] {usable} rows have at least one derived feature")
    print(f"[build-dataset] manifest -> {manifest_path}")
    if UNSOURCED_FEATURES:
        print(f"[build-dataset] NOTE unsourced offline features: {list(UNSOURCED_FEATURES)}")


if __name__ == "__main__":
    main()
