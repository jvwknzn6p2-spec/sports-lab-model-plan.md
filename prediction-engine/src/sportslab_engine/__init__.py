"""AI Sports Lab prediction engine.

The Python (ML) half of the hybrid pipeline. It owns the model/stats stages —
data ingestion, feature engineering, training, inference (XGBoost + a
transparent baseline), ensembling, probability calibration, error analysis, and
self-learning — and emits a ``GamePrediction`` JSON that the TypeScript side
(AI multi-agent review + prediction lock + settlement) consumes.

See ``README.md`` for the end-to-end flow and how it maps onto the 7 components
of the target architecture.
"""

from .contracts import (
    FEATURE_ORDER,
    GamePrediction,
    ModelOutputs,
    RawModelOutput,
)

__all__ = [
    "FEATURE_ORDER",
    "GamePrediction",
    "ModelOutputs",
    "RawModelOutput",
]

__version__ = "0.1.0"
