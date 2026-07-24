"""Confidence tier mapping.

Tiers are configurable and league-specific policies are supported. The tier is
always derived from the FINAL CALIBRATED probability, never the raw probability.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.core.enums import ConfidenceTier, League


@dataclass(frozen=True)
class TierBand:
    tier: ConfidenceTier
    min_probability: Decimal  # inclusive lower bound (as a fraction, e.g. 0.68)


# Default HandiEdge mapping (section 9), highest first.
DEFAULT_TIERS: tuple[TierBand, ...] = (
    TierBand(ConfidenceTier.S_PLUS, Decimal("0.68")),
    TierBand(ConfidenceTier.S, Decimal("0.66")),
    TierBand(ConfidenceTier.S_MINUS, Decimal("0.65")),
    TierBand(ConfidenceTier.A_PLUS, Decimal("0.63")),
    TierBand(ConfidenceTier.A, Decimal("0.61")),
    TierBand(ConfidenceTier.A_MINUS, Decimal("0.60")),
    TierBand(ConfidenceTier.B_PLUS, Decimal("0.58")),
    TierBand(ConfidenceTier.B, Decimal("0.56")),
    TierBand(ConfidenceTier.B_MINUS, Decimal("0.55")),
    TierBand(ConfidenceTier.C_PLUS, Decimal("0.53")),
    TierBand(ConfidenceTier.C, Decimal("0.51")),
    TierBand(ConfidenceTier.C_MINUS, Decimal("0.50")),
)


@dataclass(frozen=True)
class LeagueConfidencePolicy:
    """Per-league adjustment. ``promotion_bonus`` raises the effective probability
    used only for tier lookup (positive = stricter markets promote more easily),
    ``high_tier_penalty`` makes S/A tiers harder to reach (conservative)."""

    bands: tuple[TierBand, ...] = DEFAULT_TIERS
    promotion_bonus: Decimal = Decimal("0")
    high_tier_penalty: Decimal = Decimal("0")


# MLB supports stricter promotion into A and S tiers (a small bonus toward high
# tiers). NPB is conservative for strong-favorite / high-handicap scenarios.
LEAGUE_POLICIES: dict[League, LeagueConfidencePolicy] = {
    League.MLB: LeagueConfidencePolicy(promotion_bonus=Decimal("0.005")),
    League.NPB: LeagueConfidencePolicy(high_tier_penalty=Decimal("0.01")),
}


def tier_for_probability(
    probability: Decimal,
    league: League,
    policy: LeagueConfidencePolicy | None = None,
) -> ConfidenceTier:
    pol = policy or LEAGUE_POLICIES.get(league, LeagueConfidencePolicy())
    effective = probability + pol.promotion_bonus
    for band in pol.bands:
        threshold = band.min_probability
        # Apply the conservative penalty to S/A high tiers only.
        if band.tier.value.startswith(("S", "A")):
            threshold = threshold + pol.high_tier_penalty
        if effective >= threshold:
            return band.tier
    return ConfidenceTier.NONE
