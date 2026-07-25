"""AI gateway shared types (audit category 11).

Data classification drives routing: L1 (most sensitive — predictor identity, model
weights, feature hashes) may only ever go to the self-hosted Kimi K3 endpoint.
Canonical names follow the v1.1 handoff naming map (TaskType.OCR, etc.).
"""

from __future__ import annotations

from enum import Enum


class Classification(str, Enum):
    L1 = "L1"  # never leaves self-hosted infra
    L2 = "L2"
    L3 = "L3"
    PUBLIC = "PUBLIC"


class TaskType(str, Enum):
    REASONING = "REASONING"
    INTERNAL_EXPLAIN = "INTERNAL_EXPLAIN"
    LONG_REPORT = "LONG_REPORT"
    MATH = "MATH"
    OCR = "OCR"  # canonical (replaces legacy OCR_STRUCTURED)
    SENTIMENT = "SENTIMENT"
    SUMMARY = "SUMMARY"


class ProviderName(str, Enum):
    KIMI_K3 = "KIMI_K3"  # self-hosted vLLM (internal only)
    GEMINI = "GEMINI"
    GROK = "GROK"
    DEEPSEEK = "DEEPSEEK"
    CLAUDE = "CLAUDE"
    OPENAI_SOL = "OPENAI_SOL"


# Fields that are L1 and must never reach an external provider.
L1_FIELDS: frozenset[str] = frozenset(
    {"predictor_id", "model_weights_hash", "feature_hash", "model_weights"}
)
