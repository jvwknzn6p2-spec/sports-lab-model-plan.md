"""Calibrate a stated pick probability using the fitted track-record calibrator.

The track-record evaluation showed the logged predictions are over-confident by
~7 points. This tool applies the Platt calibrator fitted on those real outcomes
(``track_record_calibrator.json``) to correct a stated probability, and gives a
PLAY / PASS call when the corrected probability is too close to a coin flip.

Usage:
    uv run python analysis/calibrate_pick.py --prob 66
    uv run python analysis/calibrate_pick.py --prob 0.58 --band 0.04
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

DEFAULT_CALIBRATOR = Path(__file__).with_name("track_record_calibrator.json")
DEFAULT_PASS_BAND = 0.04  # PASS when |calibrated - 0.5| < band


def load_calibrator(path: Path = DEFAULT_CALIBRATOR) -> tuple[float, float]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return float(data["a"]), float(data["b"])


def to_fraction(prob: float) -> float:
    """Accept either 0-1 or 0-100 input; return a 0-1 probability."""
    return prob / 100.0 if prob > 1 else prob


def calibrate(prob: float, a: float, b: float) -> float:
    """Apply sigmoid(a*p + b) to a 0-1 probability."""
    z = a * prob + b
    return 1.0 / (1.0 + math.exp(-z))


def recommend(calibrated: float, band: float = DEFAULT_PASS_BAND) -> str:
    return "PASS" if abs(calibrated - 0.5) < band else "PLAY"


def evaluate(prob_input: float, band: float = DEFAULT_PASS_BAND) -> dict:
    a, b = load_calibrator()
    stated = to_fraction(prob_input)
    cal = calibrate(stated, a, b)
    return {
        "stated": round(stated, 4),
        "calibrated": round(cal, 4),
        "shift": round(cal - stated, 4),
        "decision": recommend(cal, band),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Calibrate a stated pick probability.")
    ap.add_argument("--prob", type=float, required=True, help="stated probability (0-1 or 0-100)")
    ap.add_argument("--band", type=float, default=DEFAULT_PASS_BAND, help="coin-flip PASS band")
    args = ap.parse_args()
    r = evaluate(args.prob, args.band)
    print(
        f"stated {r['stated'] * 100:.0f}%  ->  calibrated {r['calibrated'] * 100:.0f}%  "
        f"({r['shift'] * 100:+.0f} pts)   {r['decision']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
