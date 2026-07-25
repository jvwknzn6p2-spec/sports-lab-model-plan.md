"""Render a :class:`PredictionRunResponse` as a scannable daily report.

Follows the model-plan §6 layout: one prediction card per game plus a summary,
sorted so the most confident, actionable picks surface first. Pure string
building — no I/O — so it is unit-tested directly.
"""

from __future__ import annotations

from app.core.enums import ConfidenceTier
from app.domain.ai_review.confidence import TIER_ORDER
from app.schemas.prediction import GamePredictionOut, PredictionRunResponse

_TIER_RANK = {t.value: i for i, t in enumerate(TIER_ORDER)}


def _tier_sort_key(game: GamePredictionOut) -> int:
    return _TIER_RANK.get(game.confidence_tier, len(TIER_ORDER))


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value * 100:.1f}%"


def _card(game: GamePredictionOut) -> str:
    lines: list[str] = []
    header = f"{game.away} @ {game.home}"
    lines.append(header)
    lines.append(f"  Decision:   {game.decision_status}   Confidence: {game.confidence_tier}"
                 f"   Risk: {game.risk_level}")
    if game.decision_status == "PREDICT" and game.selected_team:
        lines.append(
            f"  Moneyline:  {game.selected_team} {_pct(game.normal_win_probability)}"
            f"  (loser {game.predicted_loser} {_pct(game.normal_loss_probability)})"
        )
        if game.expected_score.home is not None:
            lines.append(
                f"  Exp. score: {game.home} {game.expected_score.home:.1f}"
                f" - {game.away} {game.expected_score.away:.1f}"
            )
        if game.handicap_pick:
            lines.append(
                f"  Handicap:   {game.handicap_pick} covers {_pct(game.handicap_cover_probability)}"
            )
    elif game.pass_reason:
        lines.append(f"  Reason:     {game.pass_reason}")

    if game.ai_review is not None:
        ar = game.ai_review
        if ar.downgraded:
            lines.append(f"  AI review:  downgraded {ar.original_tier} -> {ar.final_tier}")
        for warning in ar.warnings[:4]:
            lines.append(f"    ! {warning}")
    if game.supporting_factors:
        lines.append(f"  Factors:    {', '.join(game.supporting_factors[:4])}")
    return "\n".join(lines)


def render_daily_report(response: PredictionRunResponse) -> str:
    games = sorted(response.games, key=_tier_sort_key)
    out: list[str] = []
    out.append("=" * 66)
    out.append(f"AI SPORTS LAB — {response.league} predictions for {response.slate_date}")
    out.append(f"run: {response.run_id}   model: {response.model_context.model_id}"
               f"   calibration: {response.calibration_context.status}")
    if response.model_context.fallback_used:
        out.append("  ⚠  NON-PRODUCTION fallback model — not a trained predictor.")
    out.append("=" * 66)

    for game in games:
        out.append("")
        out.append(_card(game))

    s = response.summary
    out.append("")
    out.append("-" * 66)
    out.append(
        f"Summary: {s.total_games} games | {s.predictions} predictions | "
        f"{s.passes} pass | {s.blocked} blocked"
    )

    # Best bets: the highest-confidence actionable picks (tier B+ or better).
    best_cut = _TIER_RANK[ConfidenceTier.B_PLUS.value]
    best = [
        g
        for g in games
        if g.decision_status == "PREDICT" and _tier_sort_key(g) <= best_cut
    ]
    if best:
        out.append("Best bets (B+ or higher):")
        for g in best:
            out.append(
                f"  {g.confidence_tier:>3}  {g.selected_team} ML "
                f"{_pct(g.normal_win_probability)}  ({g.away} @ {g.home})"
            )
    else:
        out.append("Best bets: none at B+ or higher today.")
    return "\n".join(out)
