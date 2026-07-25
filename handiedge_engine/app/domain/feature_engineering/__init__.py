"""Feature engineering — the FIRST stage of the pipeline.

Turns raw MLB data (season pitching lines, team hitting totals, bullpen rest,
park, weather, market odds) into the ordered numeric feature contract the
prediction adapters consume. Sabermetric math lives in :mod:`sabermetrics` and
is shared with the historical dataset builder so training and daily scoring use
one implementation.
"""

from __future__ import annotations

from app.domain.feature_engineering.sabermetrics import (
    WOBA_WEIGHTS,
    earned_run_average,
    whip,
    woba,
)

__all__ = ["WOBA_WEIGHTS", "earned_run_average", "whip", "woba"]
