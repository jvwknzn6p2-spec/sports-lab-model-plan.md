"""Responsible-gambling / non-guarantee tests (audit category 14)."""

from __future__ import annotations

import pytest

from handiedge.config import get_settings
from handiedge.errors import GuaranteedWinLanguageError, JurisdictionBlocked
from handiedge.responsible.gambling import (
    ResponsibleGamblingGate,
    assert_no_guarantee_language,
    scan_prohibited_language,
)


@pytest.mark.parametrize(
    "text",
    [
        "This is a guaranteed win",
        "a sure thing tonight",
        "risk-free bet",
        "we beat the book every time",
        "100% accurate lock of the day",
        "you can't lose with this pick",
    ],
)
def test_prohibited_language_flagged(text):
    assert scan_prohibited_language(text)
    with pytest.raises(GuaranteedWinLanguageError):
        assert_no_guarantee_language(text)


def test_clean_language_passes():
    assert_no_guarantee_language(
        "Model estimates a 57% probability; this is not a guarantee of any outcome."
    )


def test_jurisdiction_block_and_age_gate():
    settings = get_settings(blocked_jurisdictions="US,FR", min_age=21)
    gate = ResponsibleGamblingGate(settings)
    assert not gate.check(jurisdiction="US", age=30).allowed
    assert not gate.check(jurisdiction="GB", age=18).allowed  # under 21
    assert gate.check(jurisdiction="GB", age=21).allowed
    with pytest.raises(JurisdictionBlocked):
        gate.enforce(jurisdiction="US", age=40)


def test_allow_list_precedence():
    settings = get_settings(allowed_jurisdictions="JP,GB", min_age=18)
    gate = ResponsibleGamblingGate(settings)
    assert gate.check(jurisdiction="JP", age=20).allowed
    assert not gate.check(jurisdiction="DE", age=20).allowed
