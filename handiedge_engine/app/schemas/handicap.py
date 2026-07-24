"""Typed handicap value object.

The handicap is a *bounded context*: it is never treated as an ordinary decimal.
In particular the Japanese ``1半`` notation is preserved as its own type and must
NOT be normalized to the decimal 1.5.
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.core.enums import HandicapRuleStatus, HandicapType


class Handicap(BaseModel):
    """Immutable, fully-typed representation of a parsed handicap line."""

    model_config = ConfigDict(frozen=True)

    handicap_raw: str = Field(description="Original, unmodified source string.")
    handicap_display: str = Field(description="Human display form (e.g. '1半3').")
    handicap_type: HandicapType
    handicap_value: Decimal | None = Field(
        default=None,
        description=(
            "Numeric line for settlement arithmetic. None when the notation has "
            "no legitimate decimal equivalent (e.g. UNRESOLVED, or JP_HALF which is "
            "intentionally kept distinct from 1.5)."
        ),
    )
    handicap_sub_number: int | None = Field(
        default=None,
        ge=1,
        le=9,
        description="Sub number for JP_HALF_SUB notation (1..9); None otherwise.",
    )
    handicap_settlement_rule: str = Field(
        description="Identifier of the settlement rule strategy that applies."
    )
    favorite: str | None = None
    receiver: str | None = None
    rule_status: HandicapRuleStatus = HandicapRuleStatus.RESOLVED
    notes: tuple[str, ...] = ()

    @property
    def is_resolved(self) -> bool:
        return self.rule_status is HandicapRuleStatus.RESOLVED

    def to_public_dict(self) -> dict:
        return {
            "handicap_raw": self.handicap_raw,
            "handicap_display": self.handicap_display,
            "handicap_type": self.handicap_type.value,
            "handicap_value": (
                format(self.handicap_value, "f") if self.handicap_value is not None else None
            ),
            "handicap_sub_number": self.handicap_sub_number,
            "handicap_settlement_rule": self.handicap_settlement_rule,
            "favorite": self.favorite,
            "receiver": self.receiver,
            "rule_status": self.rule_status.value,
            "notes": list(self.notes),
        }
