"""Control Tower schema validation tests."""

from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from app.schemas.control_tower import ControlTowerPayload


def test_valid_payload_parses(valid_payload):
    payload = ControlTowerPayload.model_validate(valid_payload)
    assert payload.run_id == "run-2026-07-24-mlb-01"
    assert len(payload.games) == 2


def test_identical_home_away_rejected(valid_payload):
    bad = copy.deepcopy(valid_payload)
    bad["games"][0]["away"] = bad["games"][0]["home"]
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)


def test_league_scope_conflict_rejected(valid_payload):
    bad = copy.deepcopy(valid_payload)
    bad["settlement_scope"] = "NPB_REG9_ONLY"  # MLB league -> mismatch
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)


def test_duplicate_match_id_rejected(valid_payload):
    bad = copy.deepcopy(valid_payload)
    bad["games"][1]["match_id"] = bad["games"][0]["match_id"]
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)


def test_deadline_before_generated_rejected(valid_payload):
    bad = copy.deepcopy(valid_payload)
    bad["prediction_deadline"] = "2026-07-24T13:00:00Z"
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)


def test_missing_match_id_rejected(valid_payload):
    bad = copy.deepcopy(valid_payload)
    del bad["games"][0]["match_id"]
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)


def test_listed_team_must_match_pair(valid_payload):
    bad = copy.deepcopy(valid_payload)
    bad["games"][0]["listed_team"] = "XXX"
    with pytest.raises(ValidationError):
        ControlTowerPayload.model_validate(bad)
