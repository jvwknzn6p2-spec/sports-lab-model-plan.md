"""Provider routing matrix (audit category 11).

L1 tasks route only to the self-hosted KIMI_K3. An import-time assertion fails the
module if any L1 cell is mis-wired, so a mis-route cannot ship. Unknown (task,
classification) pairs fall back to the safest provider (KIMI_K3).
"""

from __future__ import annotations

from .types import Classification, ProviderName, TaskType

ROUTING_MATRIX: dict[tuple[TaskType, Classification], ProviderName] = {
    # L1: everything stays on the self-hosted Kimi K3.
    (TaskType.REASONING, Classification.L1): ProviderName.KIMI_K3,
    (TaskType.INTERNAL_EXPLAIN, Classification.L1): ProviderName.KIMI_K3,
    (TaskType.LONG_REPORT, Classification.L1): ProviderName.KIMI_K3,
    (TaskType.MATH, Classification.L1): ProviderName.KIMI_K3,
    # L2: Kimi K3 first.
    (TaskType.LONG_REPORT, Classification.L2): ProviderName.KIMI_K3,
    (TaskType.REASONING, Classification.L2): ProviderName.KIMI_K3,
    # L3: best-fit external providers.
    (TaskType.OCR, Classification.L3): ProviderName.GEMINI,
    (TaskType.SENTIMENT, Classification.L3): ProviderName.GROK,
    (TaskType.MATH, Classification.L3): ProviderName.DEEPSEEK,
    (TaskType.LONG_REPORT, Classification.L3): ProviderName.CLAUDE,
    (TaskType.REASONING, Classification.L3): ProviderName.OPENAI_SOL,
    (TaskType.SUMMARY, Classification.L3): ProviderName.GEMINI,
}

# Fail at import time if any L1 route points anywhere but KIMI_K3.
for (_task, _cls), _prov in ROUTING_MATRIX.items():
    if _cls is Classification.L1:
        assert _prov is ProviderName.KIMI_K3, f"L1 route to {_prov} is forbidden ({_task})"


class Router:
    def pick(self, task_type: TaskType, classification: Classification) -> ProviderName:
        """Pick a provider; unknown cells fall back to the safest (KIMI_K3)."""
        if classification is Classification.L1:
            return ProviderName.KIMI_K3
        return ROUTING_MATRIX.get((task_type, classification), ProviderName.KIMI_K3)
