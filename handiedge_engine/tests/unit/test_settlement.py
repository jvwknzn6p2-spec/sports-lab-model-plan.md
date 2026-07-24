"""Settlement engine unit tests: MLB extra innings, NPB reg-9, postponed/cancelled."""

from __future__ import annotations

from datetime import UTC, datetime

from app.core.enums import (
    GameStatus,
    PredictionResult,
    SettlementScope,
    SettlementStatus,
)
from app.domain.settlement.engine import settle
from app.schemas.settlement import Score, SettlementInput


def _si(**kwargs) -> SettlementInput:
    base = dict(
        prediction_lock_id="lock-1",
        official_game_id="g1",
        game_status=GameStatus.FINAL,
        official_result_source="TEST",
        official_result_timestamp=datetime(2026, 7, 25, tzinfo=UTC),
    )
    base.update(kwargs)
    return SettlementInput(**base)


def test_mlb_uses_final_including_extra_innings():
    si = _si(
        final_score=Score(home=6, away=5),
        regulation_score=Score(home=5, away=5),
    )
    out = settle(
        SettlementScope.MLB_FINAL_INCL_EXTRA,
        selected_team="NYY",
        home="NYY",
        away="BOS",
        handicap_raw="1",
        favorite="NYY",
        receiver="BOS",
        si=si,
    )
    assert out.settlement_status is SettlementStatus.SETTLED
    assert out.winning_team == "NYY"
    assert out.normal_result is PredictionResult.WIN
    assert out.score_home == 6  # extra-innings final used


def test_npb_uses_regulation_nine_only():
    # Regulation tie 5-5; a hypothetical extra-innings final 6-5 must be ignored.
    si = _si(
        final_score=Score(home=6, away=5),
        regulation_score=Score(home=5, away=5),
    )
    out = settle(
        SettlementScope.NPB_REG9_ONLY,
        selected_team="G",
        home="G",
        away="T",
        handicap_raw="1",
        favorite="G",
        receiver="T",
        si=si,
    )
    assert out.score_home == 5  # regulation score used, not the extra-innings final
    assert out.normal_result is PredictionResult.PUSH  # regulation tie


def test_npb_missing_regulation_score_voids():
    si = _si(final_score=Score(home=6, away=5), regulation_score=None)
    out = settle(
        SettlementScope.NPB_REG9_ONLY,
        selected_team="G",
        home="G",
        away="T",
        handicap_raw=None,
        favorite=None,
        receiver=None,
        si=si,
    )
    assert out.settlement_status is SettlementStatus.VOID


def test_postponed_game_voids():
    si = _si(game_status=GameStatus.POSTPONED, final_score=None)
    out = settle(
        SettlementScope.MLB_FINAL_INCL_EXTRA,
        selected_team="NYY",
        home="NYY",
        away="BOS",
        handicap_raw="1",
        favorite="NYY",
        receiver="BOS",
        si=si,
    )
    assert out.settlement_status is SettlementStatus.VOID
    assert out.void_reason == "game postponed"
    assert out.normal_result is PredictionResult.VOID


def test_cancelled_game_voids():
    si = _si(game_status=GameStatus.CANCELLED, final_score=None)
    out = settle(
        SettlementScope.MLB_FINAL_INCL_EXTRA,
        selected_team="NYY",
        home="NYY",
        away="BOS",
        handicap_raw=None,
        favorite=None,
        receiver=None,
        si=si,
    )
    assert out.settlement_status is SettlementStatus.VOID
    assert out.void_reason == "game cancelled"


def test_handicap_settled_independently():
    si = _si(final_score=Score(home=2, away=0), regulation_score=Score(home=2, away=0))
    out = settle(
        SettlementScope.MLB_FINAL_INCL_EXTRA,
        selected_team="NYY",
        home="NYY",
        away="BOS",
        handicap_raw="1半",  # split {1,2}; margin 2 -> partial win
        favorite="NYY",
        receiver="BOS",
        si=si,
    )
    assert out.normal_result is PredictionResult.WIN
    assert out.handicap_result is PredictionResult.PARTIAL_WIN
