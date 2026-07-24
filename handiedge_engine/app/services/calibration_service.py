"""Calibration service — resolves which calibrator to use.

For the MVP no fitted artifact exists, so identity calibration is used. The
service never mislabels identity output as calibrated; the calibrator itself
carries the UNCALIBRATED status and warning.
"""

from __future__ import annotations

from app.core.config import Settings
from app.domain.decision.calibration import Calibrator, IdentityCalibrator


class CalibrationService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def get_calibrator(self, league: str) -> Calibrator:
        # Hook point: load a fitted Platt/Isotonic artifact from the model
        # registry when available. Until then, identity (clearly UNCALIBRATED).
        t = self._settings.thresholds
        return IdentityCalibrator(
            version=self._settings.calibration_version,
            floor=t.probability_floor,
            ceil=t.probability_ceil,
        )
