"""Probability calibration abstraction.

Supports identity (MVP default), Platt scaling, and isotonic regression. The MVP
uses identity calibration when no fitted artifact exists — but the output NEVER
claims the probability is calibrated in that case. Clipping is always recorded
(original + adjusted values are preserved).
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from app.core.enums import CalibrationMethod, CalibrationStatus


@dataclass(frozen=True)
class CalibrationResult:
    method: CalibrationMethod
    status: CalibrationStatus
    artifact_id: str | None
    version: str
    original_probability: Decimal
    adjusted_probability: Decimal
    warning: str | None
    clipped: bool


class Calibrator(Protocol):
    def calibrate(self, probability: Decimal) -> CalibrationResult: ...


def _clip(p: Decimal, floor: Decimal, ceil: Decimal) -> tuple[Decimal, bool]:
    if p < floor:
        return floor, True
    if p > ceil:
        return ceil, True
    return p, False


class IdentityCalibrator:
    """Passes probabilities through unchanged (only safe clipping applied)."""

    def __init__(
        self,
        version: str,
        floor: Decimal = Decimal("0.01"),
        ceil: Decimal = Decimal("0.99"),
    ) -> None:
        self._version = version
        self._floor = floor
        self._ceil = ceil

    def calibrate(self, probability: Decimal) -> CalibrationResult:
        adjusted, clipped = _clip(probability, self._floor, self._ceil)
        return CalibrationResult(
            method=CalibrationMethod.IDENTITY,
            status=CalibrationStatus.UNCALIBRATED,
            artifact_id=None,
            version=self._version,
            original_probability=probability,
            adjusted_probability=adjusted,
            warning=(
                "Identity calibration only: probability is NOT statistically "
                "calibrated. Treat confidence with caution."
            ),
            clipped=clipped,
        )


class PlattCalibrator:
    """Platt scaling: sigmoid(a * logit(p) + b) using a fitted (a, b) artifact."""

    def __init__(
        self,
        a: float,
        b: float,
        artifact_id: str,
        version: str,
        floor: Decimal = Decimal("0.01"),
        ceil: Decimal = Decimal("0.99"),
    ) -> None:
        self._a = a
        self._b = b
        self._artifact_id = artifact_id
        self._version = version
        self._floor = floor
        self._ceil = ceil

    def calibrate(self, probability: Decimal) -> CalibrationResult:
        p = float(probability)
        p = min(max(p, 1e-6), 1 - 1e-6)
        logit = math.log(p / (1 - p))
        z = self._a * logit + self._b
        calibrated = 1.0 / (1.0 + math.exp(-z))
        adjusted, clipped = _clip(
            Decimal(str(calibrated)).quantize(Decimal("0.0001")), self._floor, self._ceil
        )
        return CalibrationResult(
            method=CalibrationMethod.PLATT,
            status=CalibrationStatus.CALIBRATED,
            artifact_id=self._artifact_id,
            version=self._version,
            original_probability=probability,
            adjusted_probability=adjusted,
            warning=None,
            clipped=clipped,
        )


class IsotonicCalibrator:
    """Isotonic regression via a fitted monotonic (x -> y) breakpoint table."""

    def __init__(
        self,
        x_points: list[float],
        y_points: list[float],
        artifact_id: str,
        version: str,
        floor: Decimal = Decimal("0.01"),
        ceil: Decimal = Decimal("0.99"),
    ) -> None:
        if len(x_points) != len(y_points) or len(x_points) < 2:
            raise ValueError("isotonic calibrator needs matching x/y with >=2 points")
        self._x = x_points
        self._y = y_points
        self._artifact_id = artifact_id
        self._version = version
        self._floor = floor
        self._ceil = ceil

    def calibrate(self, probability: Decimal) -> CalibrationResult:
        x = float(probability)
        idx = bisect.bisect_left(self._x, x)
        if idx == 0:
            y = self._y[0]
        elif idx >= len(self._x):
            y = self._y[-1]
        else:
            x0, x1 = self._x[idx - 1], self._x[idx]
            y0, y1 = self._y[idx - 1], self._y[idx]
            y = y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        adjusted, clipped = _clip(
            Decimal(str(y)).quantize(Decimal("0.0001")), self._floor, self._ceil
        )
        return CalibrationResult(
            method=CalibrationMethod.ISOTONIC,
            status=CalibrationStatus.CALIBRATED,
            artifact_id=self._artifact_id,
            version=self._version,
            original_probability=probability,
            adjusted_probability=adjusted,
            warning=None,
            clipped=clipped,
        )
