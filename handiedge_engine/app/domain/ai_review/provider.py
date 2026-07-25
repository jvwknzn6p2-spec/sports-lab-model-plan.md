"""Reasoning-provider abstraction for the review agents.

Agents never talk to an LLM SDK directly — they call a :class:`ReviewProvider`.
This keeps the agents pure and testable, and lets the whole pipeline run offline
(in CI, or on a game where we deliberately want deterministic-only review) via
:class:`HeuristicReviewProvider`, which is the default.

Reliability posture (from the plan §4.5): a review is a *check*, not the source
of truth. If the model refuses, errors, or returns malformed output, the agent
degrades to its deterministic verdict rather than block the pick — the failure
is reported in :attr:`ReasonOutcome.note`, never swallowed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Protocol

from app.core.logging import get_logger
from app.domain.ai_review.types import ReviewRank, Severity

logger = get_logger("ai_review.provider")

# Rank sentinel the model may return meaning "no cap".
_NO_CAP = "none"
_VALID_RANKS = {r.value for r in ReviewRank} | {_NO_CAP}
_VALID_SEVERITIES = {s.value for s in Severity}


@dataclass(frozen=True)
class LlmConcern:
    code: str
    severity: Severity
    message: str


@dataclass(frozen=True)
class LlmVerdict:
    concerns: tuple[LlmConcern, ...]
    # Highest rank the pick may hold, or None for "no cap".
    suggested_max_rank: ReviewRank | None
    overall_assessment: str


@dataclass(frozen=True)
class ReasonRequest:
    system: str  # stable, role-specific system prompt
    context: str  # per-game serialized prediction context


@dataclass(frozen=True)
class ReasonOutcome:
    ok: bool
    verdict: LlmVerdict | None
    # Provenance / failure note: "ok", "offline", "refusal", "invalid-output",
    # or "error: <message>". Surfaced so a degraded review is never silent.
    note: str


class ReviewProvider(Protocol):
    kind: str
    available: bool

    def reason(self, req: ReasonRequest) -> ReasonOutcome: ...


class HeuristicReviewProvider:
    """Offline provider. Produces no LLM judgment; agents fall back to their
    deterministic rule passes. This is the default when no API key is present."""

    kind = "heuristic"
    available = False

    def reason(self, req: ReasonRequest) -> ReasonOutcome:  # noqa: ARG002
        return ReasonOutcome(ok=False, verdict=None, note="offline")


# JSON Schema handed to the Messages API structured-outputs feature.
LLM_VERDICT_SCHEMA_NAME = "handiedge_review_verdict"
LLM_VERDICT_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "concerns": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "code": {"type": "string"},
                    "severity": {"type": "string", "enum": sorted(_VALID_SEVERITIES)},
                    "message": {"type": "string"},
                },
                "required": ["code", "severity", "message"],
            },
        },
        "suggestedMaxRank": {"type": "string", "enum": ["S", "A", "B", "C", "none"]},
        "overallAssessment": {"type": "string"},
    },
    "required": ["concerns", "suggestedMaxRank", "overallAssessment"],
}


def _parse_verdict(text: str) -> LlmVerdict | None:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    rank_raw = data.get("suggestedMaxRank")
    if rank_raw not in _VALID_RANKS:
        return None
    concerns: list[LlmConcern] = []
    for c in data.get("concerns", []):
        if not isinstance(c, dict):
            return None
        sev = c.get("severity")
        if sev not in _VALID_SEVERITIES:
            return None
        concerns.append(
            LlmConcern(
                code=str(c.get("code", "")),
                severity=Severity(sev),
                message=str(c.get("message", "")),
            )
        )
    suggested = None if rank_raw == _NO_CAP else ReviewRank(rank_raw)
    return LlmVerdict(
        concerns=tuple(concerns),
        suggested_max_rank=suggested,
        overall_assessment=str(data.get("overallAssessment", "")),
    )


class AnthropicReviewProvider:
    """Live provider backed by the Anthropic Messages API.

    The SDK is imported lazily so consumers who only use the heuristic path
    (tests, CI, offline runs) never need ``anthropic`` installed at runtime.
    Any failure degrades to a deterministic-only verdict with a provenance note.
    """

    kind = "anthropic"
    available = True

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-opus-4-8",
        max_tokens: int = 4096,
    ) -> None:
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        self._model = model
        self._max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        if self._client is None:
            import anthropic  # lazy, optional dependency

            self._client = (
                anthropic.Anthropic(api_key=self._api_key)
                if self._api_key
                else anthropic.Anthropic()
            )
        return self._client

    def reason(self, req: ReasonRequest) -> ReasonOutcome:
        try:
            client = self._get_client()
        except Exception as err:  # noqa: BLE001 - degrade, never crash a review
            return ReasonOutcome(ok=False, verdict=None, note=f"error: {err}")

        try:
            response = client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=[{"type": "text", "text": req.system}],
                messages=[{"role": "user", "content": req.context}],
            )
        except Exception as err:  # noqa: BLE001
            return ReasonOutcome(ok=False, verdict=None, note=f"error: {err}")

        if getattr(response, "stop_reason", None) == "refusal":
            return ReasonOutcome(ok=False, verdict=None, note="refusal")

        text = _extract_text(response)
        if not text:
            return ReasonOutcome(ok=False, verdict=None, note="invalid-output")
        verdict = _parse_verdict(text)
        if verdict is None:
            return ReasonOutcome(ok=False, verdict=None, note="invalid-output")
        return ReasonOutcome(ok=True, verdict=verdict, note="ok")


def _extract_text(response) -> str | None:
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    joined = "".join(parts).strip()
    return joined or None


def default_provider(api_key: str | None = None) -> ReviewProvider:
    """Choose a provider from the environment: the live Anthropic provider when
    an API key is available, otherwise the offline heuristic provider."""

    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    return AnthropicReviewProvider(api_key=key) if key else HeuristicReviewProvider()
