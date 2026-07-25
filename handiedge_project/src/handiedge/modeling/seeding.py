"""Deterministic seeding for reproducibility (audit category 6)."""

from __future__ import annotations

import os
import random

import numpy as np

DEFAULT_SEED = 20260723


def set_global_seed(seed: int = DEFAULT_SEED) -> int:
    """Seed Python and NumPy RNGs and PYTHONHASHSEED. Returns the seed used."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    return seed


def rng(seed: int = DEFAULT_SEED) -> np.random.Generator:
    """A fresh, independent, seeded Generator (preferred over global state)."""
    return np.random.default_rng(seed)
