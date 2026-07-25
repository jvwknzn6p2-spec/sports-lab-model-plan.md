"""Independent-Poisson scoring model.

A production baseball model predicts each team's *expected runs*; the joint
distribution of the final margin then follows from two independent Poisson score
distributions. This module turns a pair of expected-run means into:

  * a legitimate integer **margin distribution** (home_score - away_score), which
    the handicap engine consumes, and
  * a **moneyline** win probability that is internally consistent with that
    distribution (derived by conditioning on a non-tie outcome so the home/away
    probabilities sum to 1 as the prediction contract requires).

Everything here is pure and deterministic — no randomness, no global state.
"""

from __future__ import annotations

import math
from decimal import Decimal

# Maximum runs per team considered when building the score distribution. 20 runs
# covers virtually all baseball games; the truncated tail is renormalized away.
DEFAULT_MAX_RUNS = 20


def _poisson_pmf(mean: float, k_max: int) -> list[float]:
    """Poisson PMF over 0..k_max for a given mean (>= a small floor)."""

    mean = max(mean, 1e-6)
    pmf: list[float] = []
    # p(0) = e^-mean; p(k) = p(k-1) * mean / k  (stable recurrence, no factorials).
    p = math.exp(-mean)
    pmf.append(p)
    for k in range(1, k_max + 1):
        p = p * mean / k
        pmf.append(p)
    return pmf


def margin_distribution(
    mu_home: float,
    mu_away: float,
    max_runs: int = DEFAULT_MAX_RUNS,
    quantize: str = "0.000001",
) -> dict[str, Decimal]:
    """Return P(home_margin = m) for integer m, as a normalized Decimal map.

    The result sums to 1 (within Decimal rounding) so downstream handicap
    settlement convolution is well-formed.
    """

    home = _poisson_pmf(mu_home, max_runs)
    away = _poisson_pmf(mu_away, max_runs)

    raw: dict[int, float] = {}
    for h, ph in enumerate(home):
        if ph <= 0.0:
            continue
        for a, pa in enumerate(away):
            if pa <= 0.0:
                continue
            raw[h - a] = raw.get(h - a, 0.0) + ph * pa

    total = sum(raw.values())
    if total <= 0.0:  # pragma: no cover - defensive
        raise ValueError("degenerate margin distribution")

    q = Decimal(quantize)
    dist: dict[str, Decimal] = {
        str(margin): (Decimal(str(prob)) / Decimal(str(total))).quantize(q)
        for margin, prob in sorted(raw.items())
    }
    # Correct any rounding drift onto the modal margin so the map sums to exactly 1.
    drift = Decimal("1") - sum(dist.values())
    if drift != 0:
        modal = max(dist, key=lambda k: dist[k])
        dist[modal] = dist[modal] + drift
    return dist


def moneyline_from_margin(dist: dict[str, Decimal]) -> tuple[Decimal, Decimal]:
    """Home/away win probabilities conditioned on a non-tie (they sum to 1).

    The full ``dist`` retains tie (margin 0) mass for handicap settlement; the
    moneyline is win-vs-loss only, matching how MLB/NPB moneylines settle.
    """

    home_mass = sum(p for m, p in dist.items() if int(m) > 0)
    away_mass = sum(p for m, p in dist.items() if int(m) < 0)
    decisive = home_mass + away_mass
    if decisive <= 0:  # pragma: no cover - defensive
        return Decimal("0.5"), Decimal("0.5")
    home_p = (home_mass / decisive).quantize(Decimal("0.0001"))
    away_p = (Decimal("1") - home_p).quantize(Decimal("0.0001"))
    return home_p, away_p
