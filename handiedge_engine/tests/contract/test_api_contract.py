"""API + OpenAPI contract tests."""

from __future__ import annotations

import copy

import pytest

pytestmark = pytest.mark.contract


def test_health_and_ready(api_client):
    assert api_client.get("/health").status_code == 200
    r = api_client.get("/ready")
    assert r.status_code == 200
    assert r.json()["database"] == "ok"


def test_openapi_schema_exposes_endpoints(api_client):
    schema = api_client.get("/openapi.json").json()
    paths = schema["paths"]
    for expected in [
        "/api/v1/predictions/run",
        "/api/v1/predictions/{prediction_id}/lock",
        "/api/v1/settlements",
        "/api/v1/error-analysis/{settlement_id}",
        "/api/v1/learning/workflows",
        "/api/v1/model",
    ]:
        assert expected in paths, f"missing {expected}"


def test_model_endpoint_reports_active_adapter(api_client):
    body = api_client.get("/api/v1/model").json()
    # Default adapter in tests is the NON-PRODUCTION fallback.
    assert body["model_adapter"] == "fallback"
    assert body["is_production"] is False
    assert body["fallback"] is True
    assert body["model_id"] == "deterministic-fallback"


def test_run_prediction_response_shape(api_client, valid_payload):
    r = api_client.post("/api/v1/predictions/run", json=valid_payload)
    assert r.status_code == 200, r.text
    body = r.json()
    # Output contract (section 20) keys present.
    for key in [
        "schema_version",
        "run_id",
        "league",
        "control_tower_status",
        "prediction_status",
        "model_context",
        "calibration_context",
        "games",
        "summary",
    ]:
        assert key in body
    game = body["games"][0]
    for key in [
        "match_id",
        "selected_team",
        "predicted_loser",
        "normal_win_probability",
        "handicap_pick",
        "confidence_tier",
        "decision_status",
        "handicap_rule_status",
        "audit",
    ]:
        assert key in game


def test_invalid_payload_returns_422_envelope(api_client, examples_dir):
    import json

    bad = json.loads((examples_dir / "control_tower_invalid.json").read_text())
    r = api_client.post("/api/v1/predictions/run", json=bad)
    assert r.status_code == 422
    body = r.json()
    assert body["error_code"] == "CONTROL_TOWER_REJECTED"
    assert "correlation_id" in body
    assert "timestamp" in body


def test_conflict_returns_409(api_client, valid_payload):
    assert api_client.post("/api/v1/predictions/run", json=valid_payload).status_code == 200
    conflict = copy.deepcopy(valid_payload)
    conflict["games"][0]["favorite"] = "BOS"
    conflict["games"][0]["receiver"] = "NYY"
    r = api_client.post("/api/v1/predictions/run", json=conflict)
    assert r.status_code == 409
    assert r.json()["error_code"] == "IDEMPOTENCY_CONFLICT"


def test_full_api_lifecycle(api_client, valid_payload):
    run = api_client.post("/api/v1/predictions/run", json=valid_payload).json()
    prediction_id = run["games"][0]["audit"]["prediction_id"]

    lock = api_client.post(f"/api/v1/predictions/{prediction_id}/lock", json={})
    assert lock.status_code == 200, lock.text
    lock_id = lock.json()["prediction_lock_id"]

    settlement = api_client.post(
        "/api/v1/settlements",
        json={
            "prediction_lock_id": lock_id,
            "final_score": {"home": 6, "away": 4},
            "regulation_score": {"home": 6, "away": 4},
            "game_status": "FINAL",
            "official_result_source": "MLB_STATS_API",
            "official_result_timestamp": "2026-07-25T03:15:00Z",
        },
    )
    assert settlement.status_code == 200, settlement.text
    settlement_id = settlement.json()["settlement_id"]

    err = api_client.post(f"/api/v1/error-analysis/{settlement_id}")
    assert err.status_code == 200, err.text

    wf = api_client.post(
        "/api/v1/learning/workflows",
        json={"settlement_id": settlement_id, "league": "MLB"},
    )
    assert wf.status_code == 200, wf.text
    workflow_id = wf.json()["workflow_id"]

    advanced = api_client.post(
        f"/api/v1/learning/workflows/{workflow_id}/advance",
        json={"metrics": {"sample_size": 500, "all_games_settled": 1.0}},
    )
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["status"] == "DATA_VALIDATED"
