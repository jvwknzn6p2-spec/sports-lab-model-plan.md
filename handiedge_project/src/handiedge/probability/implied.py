"""Implied probability and vig/overround removal (audit category 3).

Raw decimal odds imply probabilities that sum to > 1 (the overround / vig). This
module converts odds -> raw implied -> *fair* (vig-removed) probabilities that sum
to exactly 1, for both two-way and multi-way markets. Three removal methods are
provided and named explicitly so usage is consistent across the codebase:

- ``multiplicative`` (a.k.a. proportional / normalized): divide by the sum.
- ``additive``: subtract the per-outcome share of the overround.
- ``shin``: Shin (1993) model estimating insider-trading proportion z.

The overround is returned as a diagnostic — a large or shifting overround can
signal a bad or manipulated line and must not be discarded silently.

Hard-rule note: vig must be removed *before* comparing to model output or
computing edge/Kelly. Using raw implied probability as if it were fair is a bug.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def decimal_to_implied(odds: float) -> float:
    if odds <= 1.0:
        raise ValueError("decimal odds must be > 1.0")
    return 1.0 / odds


@dataclass(frozen=True, slots=True)
class FairProbabilities:
    probabilities: tuple[float, ...]
    overround: float  # sum(raw implied) - 1.0 ; >0 means the book has margin
    method: str

    def __post_init__(self) -> None:
        s = sum(self.probabilities)
        if not np.isclose(s, 1.0, atol=1e-9):
            raise ValueError(f"fair probabilities must sum to 1, got {s}")


def _raw_implied(odds: list[float]) -> np.ndarray:
    arr = np.array([decimal_to_implied(o) for o in odds], dtype=float)
    return arr


def remove_vig_multiplicative(odds: list[float]) -> FairProbabilities:
    raw = _raw_implied(odds)
    booksum = float(raw.sum())
    fair = raw / booksum
    return FairProbabilities(tuple(fair.tolist()), booksum - 1.0, "multiplicative")


def remove_vig_additive(odds: list[float]) -> FairProbabilities:
    raw = _raw_implied(odds)
    n = len(raw)
    booksum = float(raw.sum())
    overround = booksum - 1.0
    fair = raw - overround / n
    # Guard against tiny negatives from a lopsided book; renormalise defensively.
    fair = np.clip(fair, 1e-12, None)
    fair = fair / fair.sum()
    return FairProbabilities(tuple(fair.tolist()), overround, "additive")


def remove_vig_shin(
    odds: list[float], *, max_iter: int = 100, tol: float = 1e-12
) -> FairProbabilities:
    """Shin (1993) vig removal. Solves for insider proportion z, then fair probs.

    For the common two-way case a closed form exists; for the general case we
    iterate. Falls back to multiplicative if the book has no margin.
    """
    raw = _raw_implied(odds)
    booksum = float(raw.sum())
    if booksum <= 1.0:  # no vig to remove
        return remove_vig_multiplicative(odds)

    if len(raw) == 2:
        pi = raw / booksum
        # Shin closed form for two outcomes.
        z = ((booksum - 1.0) * (booksum - 2.0 * pi[0] * pi[1] * booksum)) / (
            booksum * (1.0 - 2.0 * pi[0] * pi[1] * booksum) + 1e-18
        )
        z = float(np.clip(z, 0.0, 0.5))
        fair = (np.sqrt(z**2 + 4.0 * (1.0 - z) * (raw**2) / booksum) - z) / (2.0 * (1.0 - z))
        fair = fair / fair.sum()
        return FairProbabilities(tuple(fair.tolist()), booksum - 1.0, "shin")

    # General case: fixed-point iteration on z.
    z = 0.0
    for _ in range(max_iter):
        fair = (np.sqrt(z**2 + 4.0 * (1.0 - z) * (raw**2) / booksum) - z) / (2.0 * (1.0 - z))
        s = fair.sum()
        new_z = float(np.clip(z + (s - 1.0), 0.0, 0.5))
        if abs(new_z - z) < tol:
            z = new_z
            break
        z = new_z
    fair = (np.sqrt(z**2 + 4.0 * (1.0 - z) * (raw**2) / booksum) - z) / (2.0 * (1.0 - z))
    fair = fair / fair.sum()
    return FairProbabilities(tuple(fair.tolist()), booksum - 1.0, "shin")


_METHODS = {
    "multiplicative": remove_vig_multiplicative,
    "additive": remove_vig_additive,
    "shin": remove_vig_shin,
}


def remove_vig(odds: list[float], method: str = "multiplicative") -> FairProbabilities:
    """Dispatch to a named vig-removal method. Works for two-way and multi-way."""
    if len(odds) < 2:
        raise ValueError("need at least two outcomes to remove vig")
    try:
        fn = _METHODS[method]
    except KeyError as exc:
        raise ValueError(f"unknown vig-removal method {method!r}") from exc
    return fn(odds)
