"""Responsible-gambling controls and non-guarantee language (audit category 14).

Provides:
- the canonical non-guarantee disclaimer attached to every prediction surface;
- a prohibited-language scanner that flags guaranteed-win phrasing (HARD RULE) in
  any model-generated or template text;
- an age / jurisdiction gate whose refusal behaviour is jurisdiction-configurable.

None of this asserts legal/regulatory compliance — it enforces the engineering
guardrails the skill requires before any staking-facing feature ships.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..config import Settings
from ..errors import GuaranteedWinLanguageError, JurisdictionBlocked

NON_GUARANTEE_DISCLAIMER = (
    "This is a model-estimated probability, not a guarantee of any outcome. "
    "Betting involves risk of loss. Past performance does not predict future results. "
    "Please gamble responsibly."
)

# Phrases that imply certainty / beating the book. Case-insensitive, word-boundary.
_PROHIBITED = [
    r"guaranteed?\s+win",
    r"guaranteed?\s+profit",
    r"\bsure\s+thing\b",
    r"\block\b",
    r"can'?t\s+lose",
    r"cannot\s+lose",
    r"risk[-\s]?free",
    r"beat\s+the\s+(house|book|bookie|bookmaker)",
    r"100%\s+(win|accurate|certain)",
    r"\bno\s+risk\b",
]
_PATTERN = re.compile("|".join(_PROHIBITED), re.IGNORECASE)


def scan_prohibited_language(text: str) -> list[str]:
    """Return the list of prohibited phrases found (empty => clean)."""
    return [m.group(0) for m in _PATTERN.finditer(text)]


def assert_no_guarantee_language(text: str) -> None:
    """Raise if guaranteed-win language is present (skill HARD RULE)."""
    hits = scan_prohibited_language(text)
    if hits:
        raise GuaranteedWinLanguageError(f"prohibited guaranteed-win language: {hits}")


@dataclass(frozen=True, slots=True)
class GateResult:
    allowed: bool
    reason: str | None = None


class ResponsibleGamblingGate:
    """Age + jurisdiction eligibility gate. Refusal behaviour is config-driven."""

    def __init__(self, settings: Settings) -> None:
        self._allowed = settings.allowed_jurisdiction_set()
        self._blocked = settings.blocked_jurisdiction_set()
        self._min_age = settings.min_age

    def check(self, *, jurisdiction: str, age: int | None) -> GateResult:
        j = jurisdiction.strip().upper()
        if j in self._blocked:
            return GateResult(False, f"jurisdiction {j} is blocked")
        if self._allowed and j not in self._allowed:
            return GateResult(False, f"jurisdiction {j} is not in the allow-list")
        if age is None or age < self._min_age:
            return GateResult(False, f"age verification failed (min {self._min_age})")
        return GateResult(True)

    def enforce(self, *, jurisdiction: str, age: int | None) -> None:
        res = self.check(jurisdiction=jurisdiction, age=age)
        if not res.allowed:
            raise JurisdictionBlocked(res.reason or "not eligible")
