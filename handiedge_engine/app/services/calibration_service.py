"""Calibration service — resolves which calibrator to use.

If ``calibration_artifact_path`` is configured, a fitted Platt/Isotonic
calibrator is loaded and reported as CALIBRATED. Otherwise identity calibration
is used and reported as UNCALIBRATED — the output never mislabels identity as
calibrated.
"""

from __future__ import annotations

from app.core.config import Settings
from app.core.logging import get_logger
from app.domain.decision.calibration import (
    Calibrator,
    IdentityCalibrator,
    load_calibrator_from_artifact,
)

logger = get_logger("calibration")


class CalibrationService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def get_calibrator(self, league: str) -> Calibrator:
        t = self._settings.thresholds
        if self._settings.calibration_artifact_path:
            try:
                calibrator = load_calibrator_from_artifact(
                    self._settings.calibration_artifact_path,
                    floor=t.probability_floor,
                    ceil=t.probability_ceil,
                )
                logger.info(
                    "calibrator_loaded",
                    path=self._settings.calibration_artifact_path,
                    league=league,
                )
                return calibrator
            except (FileNotFoundError, ValueError, KeyError) as exc:
                # Fail safe to identity (clearly UNCALIBRATED) rather than crash;
                # never silently claim calibration that did not load.
                logger.warning("calibrator_load_failed", error=str(exc))

        return IdentityCalibrator(
            version=self._settings.calibration_version,
            floor=t.probability_floor,
            ceil=t.probability_ceil,
        )
