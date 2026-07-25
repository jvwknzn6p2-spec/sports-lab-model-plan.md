"""Gradient-boosted model — the primary ML predictor (XGBoost).

Wraps two XGBoost models behind one interface:
  * a classifier for P(home win), and
  * a regressor for the combined run total.

LightGBM is supported as a drop-in alternative member (import-guarded) so the
ensemble can carry more than one GBM without this module hard-depending on it.
Artifacts persist via XGBoost's native ``save_model`` (portable JSON), keyed to
the canonical :data:`FEATURE_ORDER`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import xgboost as xgb

from ..contracts import FEATURE_ORDER, RawModelOutput


class XgbGameModel:
    """Home-win classifier + total-runs regressor over the canonical features."""

    def __init__(self, clf: xgb.XGBClassifier, reg: xgb.XGBRegressor):
        self.clf = clf
        self.reg = reg

    @classmethod
    def train(
        cls,
        X: np.ndarray,
        y_win: np.ndarray,
        y_total: np.ndarray,
        *,
        n_estimators: int = 200,
        max_depth: int = 4,
        learning_rate: float = 0.05,
        seed: int = 7,
    ) -> "XgbGameModel":
        clf = xgb.XGBClassifier(
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=seed,
            n_jobs=2,
        )
        reg = xgb.XGBRegressor(
            n_estimators=n_estimators,
            max_depth=max_depth,
            learning_rate=learning_rate,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="reg:squarederror",
            random_state=seed,
            n_jobs=2,
        )
        clf.fit(X, y_win)
        reg.fit(X, y_total)
        return cls(clf, reg)

    def predict(self, features: dict[str, float]) -> RawModelOutput:
        row = np.array([[features[k] for k in FEATURE_ORDER]], dtype=float)
        home_win_prob = float(self.clf.predict_proba(row)[0, 1])
        predicted_total = float(self.reg.predict(row)[0])
        return RawModelOutput(
            name="xgboost",
            home_win_prob=home_win_prob,
            predicted_total=predicted_total,
        )

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.clf.save_model(directory / "xgb_clf.json")
        self.reg.save_model(directory / "xgb_reg.json")
        (directory / "feature_order.json").write_text(
            json.dumps(list(FEATURE_ORDER)), encoding="utf-8"
        )

    @classmethod
    def load(cls, directory: Path) -> "XgbGameModel":
        stored = json.loads((directory / "feature_order.json").read_text(encoding="utf-8"))
        if tuple(stored) != FEATURE_ORDER:
            raise ValueError(
                "Saved model feature order does not match current FEATURE_ORDER; retrain."
            )
        clf = xgb.XGBClassifier()
        clf.load_model(directory / "xgb_clf.json")
        reg = xgb.XGBRegressor()
        reg.load_model(directory / "xgb_reg.json")
        return cls(clf, reg)

    def feature_importance(self) -> dict[str, float]:
        booster = self.clf.get_booster()
        scores = booster.get_score(importance_type="gain")
        # XGBoost names features f0..fN in column order; map back to names.
        out: dict[str, float] = {}
        for idx, name in enumerate(FEATURE_ORDER):
            out[name] = float(scores.get(f"f{idx}", 0.0))
        return out


def artifacts_exist(directory: Path) -> bool:
    return (directory / "xgb_clf.json").exists() and (directory / "xgb_reg.json").exists()
