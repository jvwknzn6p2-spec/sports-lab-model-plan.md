"""Training pipeline — turns a historical dataset into saved artifacts.

Reads a recorded historical games CSV (the training fixture), builds the
canonical feature matrix, trains the XGBoost home-win classifier + total-runs
regressor, fits the probability calibrator on a held-out split, and writes all
artifacts to ``config.artifacts_dir``.

This is real training: run it and it fits an actual XGBoost model. The dataset
here is a recorded fixture (the live MLB history feed is blocked in this
sandbox); point ``--dataset`` at a real export to train on live history.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import log_loss, mean_absolute_error, roc_auc_score

from ..calibration.calibrator import ProbabilityCalibrator
from ..config import DEFAULT_CONFIG, EngineConfig
from ..contracts import FEATURE_ORDER
from ..models.gbm import XgbGameModel

CALIBRATOR_FILE = "calibrator.pkl"
METRICS_FILE = "training_metrics.json"
MODEL_DIR = "xgb"


@dataclass
class TrainingReport:
    n_train: int
    n_valid: int
    auc: float
    logloss: float
    total_mae: float

    def to_dict(self) -> dict[str, float | int]:
        return {
            "n_train": self.n_train,
            "n_valid": self.n_valid,
            "auc": round(self.auc, 4),
            "logloss": round(self.logloss, 4),
            "total_mae": round(self.total_mae, 4),
        }


def default_dataset_path(config: EngineConfig = DEFAULT_CONFIG) -> Path:
    return config.fixtures_dir / "historical_games.csv"


def train(
    dataset_path: Path | None = None,
    config: EngineConfig = DEFAULT_CONFIG,
    valid_fraction: float = 0.25,
    seed: int = 7,
) -> TrainingReport:
    config.ensure_dirs()
    path = dataset_path or default_dataset_path(config)
    df = pd.read_csv(path)

    missing = set(FEATURE_ORDER) - set(df.columns)
    if missing:
        raise ValueError(f"dataset missing feature columns: {sorted(missing)}")
    for target in ("home_win", "total_runs"):
        if target not in df.columns:
            raise ValueError(f"dataset missing target column: {target}")

    df = df.sample(frac=1.0, random_state=seed).reset_index(drop=True)
    split = int(len(df) * (1.0 - valid_fraction))
    train_df, valid_df = df.iloc[:split], df.iloc[split:]

    X_train = train_df[list(FEATURE_ORDER)].to_numpy(dtype=float)
    X_valid = valid_df[list(FEATURE_ORDER)].to_numpy(dtype=float)
    y_win_train = train_df["home_win"].to_numpy(dtype=int)
    y_win_valid = valid_df["home_win"].to_numpy(dtype=int)
    y_tot_train = train_df["total_runs"].to_numpy(dtype=float)
    y_tot_valid = valid_df["total_runs"].to_numpy(dtype=float)

    model = XgbGameModel.train(X_train, y_win_train, y_tot_train, seed=seed)

    # Validation metrics on raw (pre-calibration) predictions.
    raw_valid = model.clf.predict_proba(X_valid)[:, 1]
    total_valid = model.reg.predict(X_valid)
    auc = float(roc_auc_score(y_win_valid, raw_valid)) if len(set(y_win_valid)) > 1 else 0.5
    ll = float(log_loss(y_win_valid, raw_valid, labels=[0, 1]))
    mae = float(mean_absolute_error(y_tot_valid, total_valid))

    # Fit calibration on the validation split (raw prob → empirical frequency).
    calibrator = ProbabilityCalibrator.fit(raw_valid, y_win_valid)

    # Persist artifacts.
    model.save(config.artifact(MODEL_DIR))
    calibrator.save(config.artifact(CALIBRATOR_FILE))
    report = TrainingReport(len(train_df), len(valid_df), auc, ll, mae)
    config.artifact(METRICS_FILE).write_text(
        json.dumps(report.to_dict(), indent=2), encoding="utf-8"
    )
    return report
