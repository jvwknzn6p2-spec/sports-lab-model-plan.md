"""Train the production XGBoost runs models and write an artifact bundle.

Reproducible: with a fixed seed and synthetic (but feature-driven) data, this
script trains two `count:poisson` regressors that predict home/away expected
runs, computes feature medians, fits a Platt calibrator on a holdout, and writes
a self-contained artifact directory the XGBoost adapter can load.

Usage:
    python scripts/train_xgboost.py --out artifacts/xgboost_mlb --rows 4000 --seed 7

Swap `_synthetic_dataset` for a real historical loader to train a genuine model;
the feature contract (app/domain/prediction/features.py::FEATURE_NAMES) is the
integration point.
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import xgboost as xgb

# Ensure the project root is importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.domain.prediction.dataset import UNSOURCED_FEATURES  # noqa: E402
from app.domain.prediction.features import FEATURE_NAMES, FEATURE_VERSION  # noqa: E402
from app.domain.prediction.poisson import (  # noqa: E402
    margin_distribution,
    moneyline_from_margin,
)

# Plausible per-feature generative centers/scales for the synthetic dataset.
_FEATURE_SPECS = {
    "home_starter_era": (3.9, 0.9),
    "away_starter_era": (3.9, 0.9),
    "home_starter_whip": (1.25, 0.15),
    "away_starter_whip": (1.25, 0.15),
    "home_team_woba": (0.320, 0.020),
    "away_team_woba": (0.320, 0.020),
    "home_bullpen_era": (4.0, 0.7),
    "away_bullpen_era": (4.0, 0.7),
    "home_bullpen_rest_days": (2.0, 1.0),
    "away_bullpen_rest_days": (2.0, 1.0),
    "park_factor": (1.0, 0.08),
    "temp_f": (72.0, 12.0),
    "wind_mph": (7.0, 4.0),
    "implied_home_win_probability": (0.54, 0.09),
}


def _synthetic_dataset(rows: int, rng: np.random.Generator):
    x = np.zeros((rows, len(FEATURE_NAMES)), dtype="float32")
    for j, name in enumerate(FEATURE_NAMES):
        mean, sd = _FEATURE_SPECS[name]
        x[:, j] = rng.normal(mean, sd, rows)

    idx = {name: j for j, name in enumerate(FEATURE_NAMES)}

    def col(name: str) -> np.ndarray:
        return x[:, idx[name]]

    # Expected runs driven by opponent pitching, own hitting, park, weather.
    home_mu = (
        4.3
        + 1.8 * (col("home_team_woba") - 0.320) * 20
        - 0.35 * (col("away_starter_era") - 3.9)
        - 0.25 * (col("away_bullpen_era") - 4.0)
        + 2.5 * (col("park_factor") - 1.0)
        + 0.01 * (col("temp_f") - 72.0)
        + 0.3  # home-field advantage
    )
    away_mu = (
        4.3
        + 1.8 * (col("away_team_woba") - 0.320) * 20
        - 0.35 * (col("home_starter_era") - 3.9)
        - 0.25 * (col("home_bullpen_era") - 4.0)
        + 2.5 * (col("park_factor") - 1.0)
        + 0.01 * (col("temp_f") - 72.0)
    )
    home_mu = np.clip(home_mu, 1.0, 12.0)
    away_mu = np.clip(away_mu, 1.0, 12.0)

    home_runs = rng.poisson(home_mu).astype("float32")
    away_runs = rng.poisson(away_mu).astype("float32")
    return x, home_runs, away_runs


def _train_booster(x: np.ndarray, y: np.ndarray, seed: int) -> xgb.Booster:
    dtrain = xgb.DMatrix(x, label=y)
    params = {
        "objective": "count:poisson",
        "eval_metric": "poisson-nloglik",
        "max_depth": 4,
        "eta": 0.15,
        "subsample": 0.9,
        "colsample_bytree": 0.9,
        "seed": seed,
    }
    return xgb.train(params, dtrain, num_boost_round=120)


def _fit_platt(logits: np.ndarray, y: np.ndarray, iters: int = 500, lr: float = 0.1):
    """Fit sigmoid(a*logit + b) by gradient descent. Returns (a, b)."""

    a, b = 1.0, 0.0
    for _ in range(iters):
        z = a * logits + b
        p = 1.0 / (1.0 + np.exp(-z))
        ga = float(np.mean((p - y) * logits))
        gb = float(np.mean(p - y))
        a -= lr * ga
        b -= lr * gb
    return a, b


def _load_dataset(path: str):
    """Load a JSONL dataset produced by scripts/build_dataset.py.

    Rows are kept in file order, which build_dataset guarantees is chronological —
    so the downstream prefix split is a genuine time-based split. Rows with no
    derived features at all (cold start) are dropped.
    """

    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    usable = [r for r in rows if any(v is not None for v in r["features"])]
    if not usable:
        raise SystemExit(f"dataset {path} has no rows with derived features")

    x = np.array(
        [[np.nan if v is None else float(v) for v in r["features"]] for r in usable],
        dtype="float32",
    )
    home = np.array([float(r["home_runs"]) for r in usable], dtype="float32")
    away = np.array([float(r["away_runs"]) for r in usable], dtype="float32")
    print(
        f"[train] loaded {len(usable)} usable rows from {path} "
        f"(dropped {len(rows) - len(usable)} cold-start rows)"
    )
    return x, home, away


def _impute(x: np.ndarray, medians: np.ndarray) -> np.ndarray:
    """Replace NaNs with the supplied per-column medians (train-split derived)."""

    filled = x.copy()
    idx = np.where(np.isnan(filled))
    if len(idx[0]):
        filled[idx] = np.take(medians, idx[1])
    return filled


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="artifacts/xgboost_mlb")
    parser.add_argument(
        "--source",
        choices=("synthetic", "dataset"),
        default="synthetic",
        help="'dataset' trains on real history exported by scripts/build_dataset.py",
    )
    parser.add_argument("--dataset", help="JSONL path when --source dataset")
    parser.add_argument("--rows", type=int, default=4000, help="synthetic rows")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--model-id", default="xgboost-runs-mlb")
    parser.add_argument("--model-version", default="1.0.0")
    args = parser.parse_args()

    if args.source == "dataset":
        if not args.dataset:
            raise SystemExit("--source dataset requires --dataset PATH")
        x, home_runs, away_runs = _load_dataset(args.dataset)
    else:
        rng = np.random.default_rng(args.seed)
        x, home_runs, away_runs = _synthetic_dataset(args.rows, rng)

    # Time-based split: the dataset is chronological, so a prefix split trains on
    # the past and validates on the future — never the reverse.
    split = int(len(x) * 0.8)
    if split < 1 or split >= len(x):
        raise SystemExit(f"not enough rows to split (got {len(x)})")

    # Medians come from the TRAINING split only; deriving them from the full set
    # would leak validation-period information into the imputation.
    # A fully-unsourced column is all-NaN by design; nanmedian warns, so silence
    # that expected case and fall back to 0.0 for those columns.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        median_vec = np.nanmedian(x[:split], axis=0)
    unsourced_cols = [
        FEATURE_NAMES[j] for j in range(x.shape[1]) if np.isnan(median_vec[j])
    ]
    median_vec = np.nan_to_num(median_vec, nan=0.0)
    if unsourced_cols:
        print(f"[train] inert (no data in training split): {unsourced_cols}")
    x = _impute(x, median_vec)
    x_tr, x_val = x[:split], x[split:]

    home_model = _train_booster(x_tr, home_runs[:split], args.seed)
    away_model = _train_booster(x_tr, away_runs[:split], args.seed)

    # Feature medians (fallback for missing features at inference).
    medians = {name: float(median_vec[j]) for j, name in enumerate(FEATURE_NAMES)}

    # Fit Platt calibration on the validation split.
    dmat_val = xgb.DMatrix(x_val)
    mu_home_val = np.clip(home_model.predict(dmat_val), 0.5, 15.0)
    mu_away_val = np.clip(away_model.predict(dmat_val), 0.5, 15.0)
    model_home_p = np.array(
        [
            float(moneyline_from_margin(margin_distribution(float(h), float(a)))[0])
            for h, a in zip(mu_home_val, mu_away_val, strict=False)
        ]
    )
    y_val = (home_runs[split:] > away_runs[split:]).astype("float64")
    logits = np.log(np.clip(model_home_p, 1e-6, 1 - 1e-6) / np.clip(1 - model_home_p, 1e-6, 1))
    a, b = _fit_platt(logits, y_val)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    home_model.save_model(str(out / "home_runs.ubj"))
    away_model.save_model(str(out / "away_runs.ubj"))
    (out / "metadata.json").write_text(
        json.dumps(
            {
                "model_id": args.model_id,
                "model_version": args.model_version,
                "feature_version": FEATURE_VERSION,
                "feature_names": list(FEATURE_NAMES),
                "medians": medians,
                "max_runs": 20,
                "trained_rows": int(len(x)),
                "seed": args.seed,
                # Provenance: 'synthetic' models have NO real predictive power.
                "data_source": args.source,
                "dataset_path": args.dataset if args.source == "dataset" else None,
                "split": "time_based_prefix_80_20",
                # Inputs that carried no signal during training (offline-unsourced).
                "unsourced_features": (
                    list(UNSOURCED_FEATURES) if args.source == "dataset" else []
                ),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (out / "calibration.json").write_text(
        json.dumps(
            {
                "method": "PLATT",
                "a": a,
                "b": b,
                "artifact_id": f"platt-{args.model_id}-{args.model_version}",
                "version": f"calibration-platt-{args.model_version}",
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    # Report holdout accuracy for transparency.
    acc = float(np.mean((model_home_p > 0.5).astype("float64") == y_val))
    brier = float(np.mean((model_home_p - y_val) ** 2))
    print(
        f"wrote artifact -> {out}  (val_accuracy={acc:.3f} brier={brier:.4f} "
        f"platt_a={a:.3f} platt_b={b:.3f})"
    )


if __name__ == "__main__":
    main()
