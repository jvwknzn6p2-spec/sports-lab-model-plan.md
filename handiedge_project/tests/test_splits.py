"""Temporal split tests (audit category 6, HARD RULE: no random splits)."""

from __future__ import annotations

import numpy as np
import pytest

from handiedge.modeling.splits import (
    season_folds,
    temporal_train_val_test,
    walk_forward,
)


def test_walk_forward_is_causal():
    times = np.arange(100, dtype=float)
    splits = walk_forward(times, n_splits=4)
    assert len(splits) >= 1
    for s in splits:
        # Every test index is strictly after every train index (no future leak).
        assert s.train_idx.max() < s.test_idx.min()


def test_walk_forward_rejects_unsorted_time():
    times = np.array([1.0, 3.0, 2.0])
    with pytest.raises(ValueError):
        walk_forward(times, n_splits=1)


def test_season_folds_expanding():
    seasons = np.array([2021] * 3 + [2022] * 3 + [2023] * 3)
    folds = season_folds(seasons)
    assert len(folds) == 2
    # First fold trains only on 2021, tests on 2022.
    assert set(seasons[folds[0].train_idx]) == {2021}
    assert set(seasons[folds[0].test_idx]) == {2022}


def test_temporal_train_val_test_contiguous_and_ordered():
    tr, va, te = temporal_train_val_test(100, val_frac=0.2, test_frac=0.2)
    assert tr.max() < va.min() < te.min()
    assert len(tr) + len(va) + len(te) == 100
