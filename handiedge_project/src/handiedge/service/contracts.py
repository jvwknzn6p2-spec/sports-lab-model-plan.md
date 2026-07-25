"""Prediction API contracts (audit category 9).

A strict Pydantic schema separates: point probability, an uncertainty indicator,
the abstain decision + reason code, model version, feature hash, data/model
timestamps, and a plain-language rationale that is validated to contain NO
guaranteed-win language and to carry the non-guarantee disclaimer.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field, field_validator, model_validator

from ..modeling.abstention import AbstainReason
from ..responsible.gambling import NON_GUARANTEE_DISCLAIMER, scan_prohibited_language


class Decision(str, Enum):
    BET = "bet"
    ABSTAIN = "abstain"


class PredictionRequest(BaseModel):
    event_id: uuid.UUID
    jurisdiction: str = Field(min_length=2, max_length=2)
    age: int | None = None


class LeaguePredictionRequest(BaseModel):
    """League-scoped batch prediction over pre-built feature rows.

    ``features`` rows must match the league+market schema width; a mismatch is
    rejected downstream as a :class:`LeagueMismatchError` (never silently padded).
    """

    market: str
    features: list[list[float]] = Field(min_length=1)
    n_lines_seen: int = 1


class LeaguePredictionItem(BaseModel):
    prob: float = Field(ge=0.0, le=1.0)
    fair_prob: float = Field(ge=0.0, le=1.0)
    edge: float
    decision: Decision
    abstain_reason: AbstainReason | None = None


class LeaguePredictionResponse(BaseModel):
    league: str
    market: str
    model_trained: bool
    is_synthetic: bool
    predictions: list[LeaguePredictionItem]
    disclaimer: str = NON_GUARANTEE_DISCLAIMER

    model_config = {"protected_namespaces": ()}


class PredictionResponse(BaseModel):
    event_id: uuid.UUID
    decision: Decision
    prob_a: float | None = Field(default=None, ge=0.0, le=1.0)
    pick_side: str | None = None
    edge: float | None = None
    kelly_fraction: float | None = None
    # Uncertainty indicator (not a bare point estimate): half-width band on prob_a.
    uncertainty: float | None = Field(default=None, ge=0.0, le=1.0)
    abstain_reason: AbstainReason | None = None
    model_version: str
    feature_hash: str
    data_as_of: datetime
    generated_at: datetime
    rationale: str
    disclaimer: str = NON_GUARANTEE_DISCLAIMER

    model_config = {"protected_namespaces": ()}

    @field_validator("rationale")
    @classmethod
    def _no_guarantee(cls, v: str) -> str:
        hits = scan_prohibited_language(v)
        if hits:
            raise ValueError(f"rationale contains prohibited guaranteed-win language: {hits}")
        return v

    @model_validator(mode="after")
    def _coherent(self) -> PredictionResponse:
        if self.decision is Decision.BET:
            if self.prob_a is None or self.pick_side is None:
                raise ValueError("a BET decision requires prob_a and pick_side")
        else:
            if self.abstain_reason is None:
                raise ValueError("an ABSTAIN decision requires an abstain_reason")
        return self
