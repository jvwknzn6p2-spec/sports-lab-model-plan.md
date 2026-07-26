"""Tests for the track-record pick calibrator (analysis/calibrate_pick.py)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[1] / "analysis" / "calibrate_pick.py"
_spec = importlib.util.spec_from_file_location("calibrate_pick", _MODULE_PATH)
assert _spec and _spec.loader
calibrate_pick = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(calibrate_pick)


def test_to_fraction_accepts_percent_or_fraction() -> None:
    assert calibrate_pick.to_fraction(66) == 0.66
    assert calibrate_pick.to_fraction(0.66) == 0.66


def test_calibration_corrects_overconfidence() -> None:
    # Fitted on real outcomes: stated 66% should drop toward ~0.5 (over-confident).
    r = calibrate_pick.evaluate(66)
    assert r["stated"] == 0.66
    assert r["calibrated"] < r["stated"]
    assert 0.45 <= r["calibrated"] <= 0.58
    assert r["shift"] < 0


def test_recommend_pass_near_coinflip_play_otherwise() -> None:
    assert calibrate_pick.recommend(0.51, band=0.04) == "PASS"
    assert calibrate_pick.recommend(0.62, band=0.04) == "PLAY"


def test_calibrator_artifact_present_and_valid() -> None:
    a, b = calibrate_pick.load_calibrator()
    assert isinstance(a, float) and isinstance(b, float)
    # Over-confidence correction has slope < 1 (compresses toward 0.5).
    assert a < 1.0
