"""Adapter: build a normalized :class:`ReviewContext` from HandiEdge's domain
objects (Control Tower game + payload, raw prediction, Decision output).

Keeping this mapping in one place means the review agents never depend on the
upstream Pydantic schemas — they see only the faithful, decoupled view. This is
the Python equivalent of the TS ``serializePrediction`` hand-off, but sourced
from HandiEdge's richer Control Tower record.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation

from app.core.clock import to_utc
from app.core.enums import DecisionStatus, ValidationStatus
from app.domain.ai_review.confidence import coarse_of_tier
from app.domain.ai_review.types import (
    InjuryView,
    ReviewContext,
    StarterView,
    WeatherView,
)
from app.schemas.control_tower import ControlTowerGame, ControlTowerPayload
from app.schemas.decision import GameDecision
from app.schemas.prediction import RawGamePrediction


def _to_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _starter_for(game: ControlTowerGame, team: str) -> StarterView | None:
    for s in game.probable_or_confirmed_starters:
        if s.team.strip().lower() == team.strip().lower():
            return StarterView(name=s.name or "unknown", confirmed=bool(s.confirmed))
    return None


def _side_for_team(game: ControlTowerGame, team: str | None) -> str | None:
    if team is None:
        return None
    t = team.strip().lower()
    if t == game.home.strip().lower():
        return "home"
    if t == game.away.strip().lower():
        return "away"
    return None


def _injuries(game: ControlTowerGame) -> tuple[InjuryView, ...]:
    raw = game.risk_summary.get("injuries")
    if not isinstance(raw, list):
        return ()
    out: list[InjuryView] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        side = _side_for_team(game, item.get("team"))
        if side is None:
            continue
        out.append(
            InjuryView(
                player=str(item.get("player", "unknown")),
                side=side,
                status=str(item.get("status", "questionable")),
                key_player=bool(item.get("key_player", item.get("keyPlayer", False))),
            )
        )
    return tuple(out)


def _weather(game: ControlTowerGame) -> WeatherView | None:
    ws = game.weather_summary
    if not ws:
        return None
    wind = ws.get("wind_mph", ws.get("windMph"))
    if wind is None:
        return None
    try:
        wind_mph = float(wind)
    except (ValueError, TypeError):
        return None
    temp = ws.get("temp_f", ws.get("tempF"))
    try:
        temp_f = None if temp is None else float(temp)
    except (ValueError, TypeError):
        temp_f = None
    return WeatherView(
        wind_mph=wind_mph,
        wind_dir=str(ws.get("wind_dir", ws.get("windDir", "unknown"))),
        temp_f=temp_f,
    )


def _staleness_minutes(payload: ControlTowerPayload) -> int | None:
    stamps: list[datetime] = []
    for value in (
        payload.source_freshness.odds_fetched_at,
        payload.source_freshness.lineup_fetched_at,
        payload.source_freshness.weather_fetched_at,
        payload.source_freshness.schedule_fetched_at,
    ):
        if value is not None:
            stamps.append(to_utc(value))
    if not stamps:
        return None
    oldest = min(stamps)
    delta = to_utc(payload.generated_at) - oldest
    return int(delta.total_seconds() // 60)


def _component_agreement(raw: RawGamePrediction) -> Decimal | None:
    for w in raw.inference_warnings:
        if w.startswith("model_disagreement="):
            d = _to_decimal(w.split("=", 1)[1])
            if d is not None:
                return Decimal("1") - d
    return None


def _market_edge(game: ControlTowerGame, calib_home_prob: Decimal) -> Decimal | None:
    implied = _to_decimal(game.market_summary.get("implied_home_win_probability"))
    if implied is None:
        return None
    return (calib_home_prob - implied).copy_abs()


def _total_line(game: ControlTowerGame) -> Decimal | None:
    return _to_decimal(
        game.market_summary.get("total_line", game.odds_summary.get("total"))
    )


def _available(game: ControlTowerGame, feature: str, summary: dict) -> bool:
    """A feature is available unless the summary is empty or it is explicitly
    listed as a missing feature by the upstream feature builder."""

    if feature in set(game.feature_summary.missing_features):
        return False
    return bool(summary)


def build_review_context(
    game: ControlTowerGame,
    payload: ControlTowerPayload,
    raw: RawGamePrediction,
    decision: GameDecision,
    calib_home_prob: Decimal,
    calib_away_prob: Decimal,
    prediction_id: str | None = None,
) -> ReviewContext:
    expected_home = decision.expected_score_home
    expected_away = decision.expected_score_away
    predicted_total = (
        expected_home + expected_away
        if expected_home is not None and expected_away is not None
        else None
    )
    missing = set(game.feature_summary.missing_features)

    return ReviewContext(
        match_id=game.match_id,
        prediction_id=prediction_id,
        home=game.home,
        away=game.away,
        schedule_confirmed=game.validation_status is ValidationStatus.VALIDATED,
        home_starter=_starter_for(game, game.home),
        away_starter=_starter_for(game, game.away),
        batting_stats_available=_available(game, "batting", game.lineup_summary),
        bullpen_stats_available=_available(game, "bullpen", game.bullpen_summary),
        recent_form_available="recent_form" not in missing,
        park_factors_available="park_factors" not in missing,
        odds_available=bool(game.odds_summary) or bool(game.market_summary),
        weather=_weather(game),
        injuries=_injuries(game),
        staleness_minutes=_staleness_minutes(payload),
        home_win_prob=calib_home_prob,
        away_win_prob=calib_away_prob,
        component_agreement=_component_agreement(raw),
        market_edge=_market_edge(game, calib_home_prob),
        predicted_total=predicted_total,
        total_line=_total_line(game),
        original_tier_rank=coarse_of_tier(decision.confidence_tier),
        is_predict=decision.decision_status is DecisionStatus.PREDICT,
        key_factors=tuple(decision.supporting_factors),
    )
