"""Command-line entry point for the Python engine stages.

    python -m sportslab_engine.cli train      [--dataset PATH]
    python -m sportslab_engine.cli predict     --date YYYY-MM-DD
    python -m sportslab_engine.cli analyze     --settled PATH
    python -m sportslab_engine.cli learn       --report PATH

These are the model/stats stages of the hybrid pipeline; the TypeScript side
handles AI review, prediction lock, and settlement between `predict` and
`analyze`. See the top-level `run_pipeline.sh` for the full end-to-end loop.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import DEFAULT_CONFIG
from .error_analysis.analyze import analyze
from .pipeline import write_predictions
from .self_learning.learn import learn
from .training.train import train


def _cmd_train(args: argparse.Namespace) -> int:
    dataset = Path(args.dataset) if args.dataset else None
    report = train(dataset_path=dataset)
    print("training complete:", json.dumps(report.to_dict()))
    return 0


def _cmd_predict(args: argparse.Namespace) -> int:
    path = write_predictions(args.date)
    payload = json.loads(path.read_text(encoding="utf-8"))
    print(f"wrote {len(payload['predictions'])} predictions → {path}")
    print(f"gbm trained: {payload['gbmTrained']}")
    for p in payload["predictions"]:
        ml = p["model"]["moneyline"]
        print(
            f"  {p['gameId']}: home {ml['homeWinProb']:.2f} "
            f"conf {p['confidence']} edge {p['model']['marketEdge']:.3f}"
        )
    return 0


def _cmd_analyze(args: argparse.Namespace) -> int:
    settled = json.loads(Path(args.settled).read_text(encoding="utf-8"))
    report = analyze(settled)
    DEFAULT_CONFIG.ensure_dirs()
    date = report.get("date", "unknown")
    out = DEFAULT_CONFIG.output(f"error_report_{date}.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"wrote error report → {out}")
    print(json.dumps(report, indent=2))
    return 0


def _cmd_learn(args: argparse.Namespace) -> int:
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    result = learn(report, DEFAULT_CONFIG.artifacts_dir)
    print("self-learning update:")
    print(json.dumps(result, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sportslab-engine")
    sub = parser.add_subparsers(dest="command", required=True)

    p_train = sub.add_parser("train", help="train models + calibrator on a dataset")
    p_train.add_argument("--dataset", help="path to historical games CSV")
    p_train.set_defaults(func=_cmd_train)

    p_pred = sub.add_parser("predict", help="run the pipeline for a date")
    p_pred.add_argument("--date", required=True, help="YYYY-MM-DD")
    p_pred.set_defaults(func=_cmd_predict)

    p_an = sub.add_parser("analyze", help="error analysis on settled predictions")
    p_an.add_argument("--settled", required=True, help="path to settled JSON")
    p_an.set_defaults(func=_cmd_analyze)

    p_learn = sub.add_parser("learn", help="self-learning update from an error report")
    p_learn.add_argument("--report", required=True, help="path to error report JSON")
    p_learn.set_defaults(func=_cmd_learn)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
