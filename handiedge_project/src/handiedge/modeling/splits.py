"""Temporal train/validation/test splits (audit category 6, HARD RULE).

Sports outcomes are temporally ordered and serially correlated. Splits MUST be
time-based. Random/shuffled k-fold on match-level rows is a leakage bug — this
module provides only time-ordered splitters and an explicit guard that rejects
non-monotonic time inputs.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class Split:
    train_idx: np.ndarray
    test_idx: np.ndarray


def _check_sorted(times: np.ndarray) -> None:
    if len(times) and np.any(np.diff(times.astype("float64")) < 0):
        raise ValueError(
            "input must be sorted ascending by time before splitting; "
            "temporal integrity is required (no shuffling)."
        )


def walk_forward(times: np.ndarray, n_splits: int = 5, min_train: int = 1) -> list[Split]:
    """Expanding-window walk-forward splits over time-sorted rows.

    Fold k trains on the first k blocks and tests on block k+1, so the model only
    ever sees the past relative to each test row.
    """
    _check_sorted(times)
    n = len(times)
    if n_splits < 1 or n <= n_splits:
        raise ValueError("need more rows than splits")
    bounds = np.linspace(0, n, n_splits + 2, dtype=int)
    splits: list[Split] = []
    for k in range(1, n_splits + 1):
        tr_end = bounds[k]
        te_end = bounds[k + 1]
        if tr_end < min_train or te_end <= tr_end:
            continue
        splits.append(Split(np.arange(0, tr_end), np.arange(tr_end, te_end)))
    return splits


def season_folds(seasons: np.ndarray) -> list[Split]:
    """Season-based walk-forward: train on all prior seasons, test on the next.

    ``seasons`` is a per-row season label (already time-ordered across seasons).
    """
    uniq = sorted(set(seasons.tolist()))
    idx = np.arange(len(seasons))
    folds: list[Split] = []
    for i in range(1, len(uniq)):
        tr = idx[np.isin(seasons, uniq[:i])]
        te = idx[seasons == uniq[i]]
        if len(tr) and len(te):
            folds.append(Split(tr, te))
    return folds


def temporal_train_val_test(
    n: int, val_frac: float = 0.2, test_frac: float = 0.2
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Contiguous time-ordered train/val/test index split (no shuffling)."""
    if not 0 < val_frac < 1 or not 0 < test_frac < 1 or val_frac + test_frac >= 1:
        raise ValueError("invalid fractions")
    idx = np.arange(n)
    test_start = int(n * (1 - test_frac))
    val_start = int(test_start * (1 - val_frac))
    return idx[:val_start], idx[val_start:test_start], idx[test_start:]
