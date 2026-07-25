"""Programmatic OpticOdds client over the runtime ``external-tool`` binary.

Design constraints (from the connector discovery):
- Invoke ``external-tool call '<json>'`` with **argv only** — no shell, no string
  interpolation, so nothing can be injected via a path/param.
- Credentials are injected by the runtime; this code never reads/holds an API key.
- The connector returns an envelope ``{"status_code", "data": {...}}``; some
  runtimes wrap that again (``{"output": <json-or-string>}``) — we unwrap defensively.
- Empty odds (``data: []``) is a *normal* result, surfaced as an empty list.
- Failures are typed: unavailable binary, timeout, nonzero exit, auth-required,
  rate-limit, malformed output.

The subprocess call is behind a :class:`SubprocessRunner` Protocol so tests inject a
deterministic fake and never spawn a real process.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass
from typing import Any, Protocol

from ..errors import (
    AuthRequired,
    ConnectorError,
    ConnectorTimeout,
    ConnectorUnavailable,
    MalformedResponse,
    RateLimited,
)


@dataclass(frozen=True, slots=True)
class ToolEnvelope:
    """Validated connector response: HTTP-like status plus the inner payload."""

    status_code: int
    data: Any
    raw: dict[str, Any]


class SubprocessRunner(Protocol):
    """Runs an argv command with a timeout and returns (returncode, stdout, stderr)."""

    async def run(self, argv: list[str], timeout_s: float) -> tuple[int, str, str]: ...


class AsyncSubprocessRunner:
    """Default runner: ``asyncio`` subprocess, argv-only, hard timeout with kill."""

    async def run(self, argv: list[str], timeout_s: float) -> tuple[int, str, str]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:  # binary not installed
            raise ConnectorUnavailable(
                f"external-tool binary {argv[0]!r} not found on PATH; connector unavailable"
            ) from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise ConnectorTimeout(f"external-tool call exceeded {timeout_s}s") from exc
        return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


_WRAPPER_KEYS = ("output", "result", "content", "body", "response")


class ExternalToolClient:
    """Generic programmatic client for one connector source/tool."""

    def __init__(
        self,
        *,
        source_id: str,
        tool_name: str,
        binary: str = "external-tool",
        timeout_s: float = 30.0,
        runner: SubprocessRunner | None = None,
    ) -> None:
        self._source_id = source_id
        self._tool_name = tool_name
        self._binary = binary
        self._timeout_s = timeout_s
        self._runner = runner or AsyncSubprocessRunner()

    @staticmethod
    def is_available(binary: str = "external-tool") -> bool:
        """Truthful availability probe for CLI/health reporting."""
        return shutil.which(binary) is not None

    async def call(
        self,
        *,
        path: str,
        method: str = "GET",
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> ToolEnvelope:
        payload = {
            "source_id": self._source_id,
            "tool_name": self._tool_name,
            "arguments": {
                "path": path,
                "method": method.upper(),
                "params": params or {},
                "json_body": json_body,
            },
        }
        argv = [self._binary, "call", json.dumps(payload, separators=(",", ":"))]
        code, out, err = await self._runner.run(argv, self._timeout_s)
        if code != 0:
            self._raise_for_process_error(code, err or out)
        env = self._parse_envelope(out)
        self._raise_for_status(env)
        return env

    # -- internals -----------------------------------------------------------

    def _raise_for_process_error(self, code: int, stderr: str) -> None:
        low = (stderr or "").lower()
        if "not found" in low and "external-tool" in low:
            raise ConnectorUnavailable(f"connector unavailable (exit {code}): {stderr.strip()}")
        if any(t in low for t in ("unauthor", "forbidden", "auth", "401", "403")):
            raise AuthRequired(f"connector auth required (exit {code}): {stderr.strip()}")
        if "429" in low or "rate limit" in low or "ratelimit" in low or "too many" in low:
            raise RateLimited(f"connector rate-limited (exit {code}): {stderr.strip()}")
        if "timeout" in low or "timed out" in low:
            raise ConnectorTimeout(f"connector timed out (exit {code}): {stderr.strip()}")
        raise ConnectorError(f"external-tool exited {code}: {stderr.strip() or 'no stderr'}")

    def _parse_envelope(self, out: str) -> ToolEnvelope:
        text = (out or "").strip()
        if not text:
            raise MalformedResponse("empty output from external-tool")
        try:
            obj: Any = json.loads(text)
        except json.JSONDecodeError as exc:
            raise MalformedResponse(f"non-JSON output from external-tool: {exc}") from exc
        obj = self._unwrap(obj)
        if not isinstance(obj, dict):
            raise MalformedResponse(f"expected an object envelope, got {type(obj).__name__}")
        status = obj.get("status_code", 200 if "data" in obj else None)
        if status is None:
            raise MalformedResponse("envelope missing 'status_code' and 'data'")
        try:
            status_int = int(status)
        except (TypeError, ValueError) as exc:
            raise MalformedResponse(f"non-integer status_code: {status!r}") from exc
        return ToolEnvelope(status_code=status_int, data=obj.get("data"), raw=obj)

    def _unwrap(self, obj: Any, _depth: int = 0) -> Any:
        """Unwrap runtime wrappers like ``{"output": <json-string-or-dict>}``."""
        if _depth > 4 or not isinstance(obj, dict):
            return obj
        if "status_code" in obj or "data" in obj:
            return obj
        for key in _WRAPPER_KEYS:
            if key in obj and len(obj) <= 2:
                inner = obj[key]
                if isinstance(inner, str):
                    try:
                        inner = json.loads(inner)
                    except json.JSONDecodeError:
                        return obj
                return self._unwrap(inner, _depth + 1)
        return obj

    def _raise_for_status(self, env: ToolEnvelope) -> None:
        code = env.status_code
        if code in (401, 403):
            raise AuthRequired(f"connector returned {code}")
        if code == 429:
            raise RateLimited("connector returned 429")
        if code >= 400:
            raise ConnectorError(f"connector returned status {code}")


def _extract_rows(env: ToolEnvelope) -> list[dict[str, Any]]:
    """Return the list at ``data.data`` (nested) or ``data`` (flat).

    An absent/empty collection yields ``[]`` — empty odds is a normal outcome.
    """
    data = env.data
    if isinstance(data, dict):
        inner = data.get("data", [])
        return list(inner) if isinstance(inner, list) else []
    if isinstance(data, list):
        return list(data)
    return []


class OpticOddsConnector:
    """High-level OpticOdds calls used by the ingestion services.

    Bounded snapshots only — the connector does not stream in this project.
    """

    def __init__(self, client: ExternalToolClient) -> None:
        self._client = client

    async def leagues(self, sport: str = "baseball") -> list[dict[str, Any]]:
        env = await self._client.call(path="/leagues", params={"sport": sport})
        return _extract_rows(env)

    async def active_fixtures(self, league: str) -> list[dict[str, Any]]:
        env = await self._client.call(path="/fixtures/active", params={"league": league})
        return _extract_rows(env)

    async def fixture_odds(
        self,
        *,
        league: str,
        fixture_ids: list[str],
        sportsbooks: list[str],
        markets: list[str],
    ) -> list[dict[str, Any]]:
        # Force decimal odds at the request boundary. The OpticOdds API defaults to
        # American odds (e.g. -172), but the normalizer strictly expects decimal
        # prices > 1.0; without this the live NPB call returned American prices and
        # normalization (correctly) rejected them. Do not let callers override it.
        params: dict[str, Any] = {
            "league": league,
            "fixture_id": fixture_ids,
            "sportsbook": sportsbooks,
            "market": markets,
            "odds_format": "DECIMAL",
        }
        env = await self._client.call(path="/fixtures/odds", params=params)
        return _extract_rows(env)

    async def fixture_results(self, *, league: str, fixture_ids: list[str]) -> list[dict[str, Any]]:
        env = await self._client.call(
            path="/fixtures/results", params={"league": league, "fixture_id": fixture_ids}
        )
        return _extract_rows(env)
