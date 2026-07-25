"""ExternalToolClient / OpticOddsConnector tests — fully offline (fake runner).

Covers envelope parsing, runtime wrapper unwrapping, empty odds, and the typed
error surface (timeout, nonzero exit, auth, rate-limit, malformed, unavailable).
No real subprocess is ever spawned.
"""

from __future__ import annotations

import json
import sys

import pytest

from handiedge.connector.external_tool import (
    AsyncSubprocessRunner,
    ExternalToolClient,
    OpticOddsConnector,
    _extract_rows,
)
from handiedge.errors import (
    AuthRequired,
    ConnectorError,
    ConnectorTimeout,
    ConnectorUnavailable,
    MalformedResponse,
    RateLimited,
)


class FakeRunner:
    """Returns a canned (returncode, stdout, stderr) and records the argv it saw."""

    def __init__(self, code=0, out="", err=""):
        self.code = code
        self.out = out
        self.err = err
        self.calls: list[list[str]] = []

    async def run(self, argv, timeout_s):
        self.calls.append(argv)
        return self.code, self.out, self.err


def _client(runner):
    return ExternalToolClient(
        source_id="opticodds", tool_name="opticodds", binary="external-tool", runner=runner
    )


async def test_call_builds_argv_payload_no_shell():
    runner = FakeRunner(out=json.dumps({"status_code": 200, "data": {"data": []}}))
    client = _client(runner)
    await client.call(path="/leagues", params={"sport": "baseball"})
    assert len(runner.calls) == 1
    argv = runner.calls[0]
    assert argv[0] == "external-tool" and argv[1] == "call"
    payload = json.loads(argv[2])  # single JSON arg, no shell interpolation
    assert payload["source_id"] == "opticodds"
    assert payload["arguments"]["path"] == "/leagues"
    assert payload["arguments"]["params"] == {"sport": "baseball"}


async def test_unwraps_runtime_output_wrapper():
    inner = {"status_code": 200, "data": {"data": [{"id": "x"}]}}
    runner = FakeRunner(out=json.dumps({"output": json.dumps(inner)}))
    env = await _client(runner).call(path="/leagues")
    assert env.status_code == 200
    assert _extract_rows(env) == [{"id": "x"}]


async def test_empty_odds_is_normal_empty_list():
    runner = FakeRunner(out=json.dumps({"status_code": 200, "data": {"data": []}}))
    env = await _client(runner).call(path="/fixtures/odds")
    assert _extract_rows(env) == []


async def test_auth_and_rate_limit_from_status():
    auth = FakeRunner(out=json.dumps({"status_code": 401, "data": None}))
    with pytest.raises(AuthRequired):
        await _client(auth).call(path="/x")
    rate = FakeRunner(out=json.dumps({"status_code": 429, "data": None}))
    with pytest.raises(RateLimited):
        await _client(rate).call(path="/x")


async def test_nonzero_exit_maps_to_typed_errors():
    with pytest.raises(AuthRequired):
        await _client(FakeRunner(code=2, err="401 Unauthorized")).call(path="/x")
    with pytest.raises(RateLimited):
        await _client(FakeRunner(code=3, err="rate limit exceeded")).call(path="/x")
    with pytest.raises(ConnectorTimeout):
        await _client(FakeRunner(code=4, err="request timed out")).call(path="/x")
    with pytest.raises(ConnectorError):
        await _client(FakeRunner(code=1, err="boom")).call(path="/x")


async def test_malformed_output_raises():
    with pytest.raises(MalformedResponse):
        await _client(FakeRunner(out="not json")).call(path="/x")
    with pytest.raises(MalformedResponse):
        await _client(FakeRunner(out="")).call(path="/x")
    with pytest.raises(MalformedResponse):
        await _client(FakeRunner(out=json.dumps({"nope": 1}))).call(path="/x")


async def test_connector_high_level_calls_pass_params():
    fixture = {"status_code": 200, "data": {"data": [{"id": "f1"}]}}
    runner = FakeRunner(out=json.dumps(fixture))
    conn = OpticOddsConnector(_client(runner))
    rows = await conn.fixture_odds(
        league="mlb",
        fixture_ids=["f1"],
        sportsbooks=["draftkings"],
        markets=["moneyline"],
    )
    assert rows == [{"id": "f1"}]
    payload = json.loads(runner.calls[0][2])
    assert payload["arguments"]["params"]["league"] == "mlb"
    assert payload["arguments"]["params"]["market"] == ["moneyline"]


async def test_fixture_odds_request_forces_decimal_format():
    # Regression for the live-smoke finding: the OpticOdds API defaults to American
    # odds (e.g. -172), which the normalizer rejects. Every /fixtures/odds request
    # must explicitly ask for DECIMAL while preserving the caller's other params.
    runner = FakeRunner(out=json.dumps({"status_code": 200, "data": {"data": []}}))
    conn = OpticOddsConnector(_client(runner))
    await conn.fixture_odds(
        league="npb",
        fixture_ids=["f1", "f2"],
        sportsbooks=["draftkings", "fanduel"],
        markets=["moneyline", "total_runs"],
    )
    params = json.loads(runner.calls[0][2])["arguments"]["params"]
    assert params["odds_format"] == "DECIMAL"
    # caller params preserved alongside the forced format
    assert params["league"] == "npb"
    assert params["fixture_id"] == ["f1", "f2"]
    assert params["sportsbook"] == ["draftkings", "fanduel"]
    assert params["market"] == ["moneyline", "total_runs"]


def test_is_available_probe(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _b: None)
    assert ExternalToolClient.is_available("external-tool") is False
    monkeypatch.setattr("shutil.which", lambda _b: "/usr/local/bin/external-tool")
    assert ExternalToolClient.is_available("external-tool") is True


async def test_real_runner_missing_binary_is_unavailable():
    # No fake runner: the default AsyncSubprocessRunner must surface a missing
    # binary as ConnectorUnavailable (environmental gap), never a crash.
    client = ExternalToolClient(
        source_id="opticodds", tool_name="opticodds", binary="definitely-not-a-real-binary-xyz"
    )
    with pytest.raises(ConnectorUnavailable):
        await client.call(path="/leagues")


async def test_missing_runtime_dependency_maps_to_connector_error():
    # Regression for the live-smoke finding: the runtime `external-tool` shebang is
    # `#!/usr/bin/env python3`, so under `uv run` it executes with the project venv
    # interpreter. When that interpreter can't import `requests`, the tool exits 1
    # with a ModuleNotFoundError on stderr. The client must surface that as a typed
    # ConnectorError (not crash, not swallow it as success).
    stderr = "Traceback (most recent call last):\nModuleNotFoundError: No module named 'requests'"
    with pytest.raises(ConnectorError) as exc:
        await _client(FakeRunner(code=1, err=stderr)).call(path="/fixtures/active")
    assert "requests" in str(exc.value)


async def test_runtime_interpreter_can_import_requests():
    # Regression for the same finding: the `external-tool` shebang resolves
    # `python3` against the (uv-modified) PATH, i.e. the same venv interpreter that
    # runs this test. That interpreter MUST be able to import `requests`, otherwise
    # every live connector call fails before making a request. This exercises the
    # real subprocess runner and would have failed before `requests` was pinned.
    code, out, err = await AsyncSubprocessRunner().run(
        [sys.executable, "-c", "import requests; print(requests.__version__)"], timeout_s=30.0
    )
    assert code == 0, f"runtime interpreter cannot import requests: {err.strip()}"
    assert out.strip(), "expected a requests version on stdout"
