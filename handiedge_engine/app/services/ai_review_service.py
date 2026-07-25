"""AI review service — Step 9 lifecycle stage.

Runs the three specialist reviewers over a finished Decision-Engine result and
returns a possibly-downgraded decision plus the auditable review record. The
service holds no business logic of its own: the review math lives in
:mod:`app.domain.ai_review`. This mirrors HandiEdge's rule that services
orchestrate and domains decide.
"""

from __future__ import annotations

from decimal import Decimal

from app.core.clock import isoformat_utc, utc_now
from app.core.config import Settings
from app.domain.ai_review import (
    ReviewProvider,
    apply_review_to_tier,
    build_review_context,
    default_provider,
    review_prediction,
)
from app.domain.ai_review.types import ReviewResult
from app.schemas.ai_review import AiReviewFlagOut, AiReviewOut, AiReviewVerdictOut
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.decision import GameDecision
from app.schemas.prediction import RawGamePrediction


class AiReviewService:
    def __init__(self, settings: Settings, provider: ReviewProvider | None = None) -> None:
        self._settings = settings
        # Offline heuristic by default; live LLM only when an API key is present.
        self._provider = provider or default_provider()

    @property
    def provider_kind(self) -> str:
        return self._provider.kind

    def apply(
        self,
        game: ControlTowerGame,
        payload: ControlTowerPayload,
        raw: RawGamePrediction,
        decision: GameDecision,
        calib_home_prob: Decimal,
        calib_away_prob: Decimal,
        prediction_id: str,
    ) -> tuple[GameDecision, AiReviewOut, ReviewResult]:
        reviewed_at = isoformat_utc(utc_now())
        ctx = build_review_context(
            game,
            payload,
            raw,
            decision,
            calib_home_prob,
            calib_away_prob,
            prediction_id=prediction_id,
        )
        result = review_prediction(ctx, self._provider, reviewed_at=reviewed_at)

        # Fold the coarse cap back onto the fine tier — never raising it.
        new_tier = apply_review_to_tier(decision.confidence_tier, result.final_rank)
        reviewed_decision = decision
        if new_tier != decision.confidence_tier:
            reviewed_decision = decision.model_copy(update={"confidence_tier": new_tier})

        out = AiReviewOut(
            reviewed=True,
            original_rank=result.original_rank.value,
            final_rank=result.final_rank.value,
            original_tier=decision.confidence_tier.value,
            final_tier=new_tier.value,
            downgraded=new_tier != decision.confidence_tier,
            provider=self._provider.kind,
            reviewed_at=reviewed_at,
            warnings=list(result.warnings),
            flags=[
                AiReviewFlagOut(
                    agent=f.agent.value,
                    severity=f.severity.value,
                    code=f.code,
                    message=f.message,
                )
                for f in result.flags
            ],
            verdicts=[
                AiReviewVerdictOut(
                    agent=v.agent.value,
                    ok=v.ok,
                    suggested_max_rank=(
                        v.suggested_max_rank.value if v.suggested_max_rank else None
                    ),
                    reasoning=v.reasoning,
                    source=v.source.value,
                    flags=[
                        AiReviewFlagOut(
                            agent=f.agent.value,
                            severity=f.severity.value,
                            code=f.code,
                            message=f.message,
                        )
                        for f in v.flags
                    ],
                )
                for v in result.verdicts
            ],
        )
        return reviewed_decision, out, result
