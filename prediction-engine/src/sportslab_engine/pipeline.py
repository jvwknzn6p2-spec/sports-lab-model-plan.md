"""Prediction pipeline — the Python half, end to end.

Chains: ingest slate → build features → run the Prediction Engine (Component 1)
→ Ensemble Manager (Component 2) → Probability Calibration (Component 3) →
derive markets/EV/confidence → emit a ``GamePrediction`` per game as the JSON the
TypeScript AI review + lock consume.

The pre-review confidence rank here is a thin stand-in for the full Step-7
ranker: it is a purely quantitative rank (edge × agreement). The AI multi-agent
review and the data-completeness checks then adjust it downstream.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .calibration.calibrator import ProbabilityCalibrator
from .config import DEFAULT_CONFIG, EngineConfig
from .contracts import GamePrediction, ModelOutputs
from .engine.predict import PredictionEngine
from .ensemble.manager import combine, load_weights
from .features.builder import build_features
from .ingest.slate import load_slate
from .training.train import CALIBRATOR_FILE

_TOTAL_SIGMA = 3.0  # std of combined runs, for over/under probabilities
_WIN_BY_2_GIVEN_WIN = 0.62  # share of wins that are by 2+ runs (run-line heuristic)


# --- American-odds helpers -------------------------------------------------


def implied_prob(american: int) -> float:
    return (-american) / (-american + 100) if american < 0 else 100 / (american + 100)


def decimal_odds(american: int) -> float:
    return 1 + 100 / (-american) if american < 0 else 1 + american / 100


def _ev_per_unit(prob: float, american: int) -> float:
    profit = decimal_odds(american) - 1
    return prob * profit - (1 - prob) * 1.0


def _norm_sf(x: float, mu: float, sigma: float) -> float:
    """P(X > x) for X ~ Normal(mu, sigma)."""
    z = (x - mu) / (sigma * math.sqrt(2))
    return 0.5 * math.erfc(z)


def _pre_review_rank(market_edge: float, agreement: float) -> str:
    if market_edge >= 0.06 and agreement >= 0.75:
        return "S"
    if market_edge >= 0.04 and agreement >= 0.65:
        return "A"
    if market_edge >= 0.02:
        return "B"
    return "C"


def _build_ev_bets(
    home_prob: float,
    over_prob: float,
    home_abbr: str,
    away_abbr: str,
    odds: dict[str, Any],
) -> tuple[list[dict[str, Any]], float]:
    bets: list[dict[str, Any]] = []
    ml = odds.get("moneyline", {})
    total = odds.get("total", {})

    # Moneyline: evaluate the side the model favors.
    if "home" in ml and "away" in ml:
        if home_prob >= 0.5:
            side_prob, side_odds, sel = home_prob, int(ml["home"]), f"{home_abbr} ML"
        else:
            side_prob, side_odds, sel = 1 - home_prob, int(ml["away"]), f"{away_abbr} ML"
        edge = side_prob - implied_prob(side_odds)
        ev = _ev_per_unit(side_prob, side_odds)
        bets.append(
            {
                "market": "moneyline",
                "selection": sel,
                "edge": round(edge, 4),
                "evPer1Unit": round(ev, 4),
                "positive": ev > 0,
            }
        )
        headline_edge = edge
    else:
        headline_edge = 0.0

    # Total: evaluate over vs under, whichever the model leans.
    if "line" in total and "over" in total and "under" in total:
        line = float(total["line"])
        if over_prob >= 0.5:
            side_prob, side_odds, sel = over_prob, int(total["over"]), f"OVER {line}"
        else:
            side_prob, side_odds, sel = 1 - over_prob, int(total["under"]), f"UNDER {line}"
        ev = _ev_per_unit(side_prob, side_odds)
        bets.append(
            {
                "market": "total",
                "selection": sel,
                "edge": round(side_prob - implied_prob(side_odds), 4),
                "evPer1Unit": round(ev, 4),
                "positive": ev > 0,
            }
        )

    return bets, headline_edge


def predict_game(
    game: dict[str, Any],
    engine: PredictionEngine,
    weights: dict[str, float],
    calibrator: ProbabilityCalibrator,
) -> GamePrediction:
    features = build_features(game)
    members = engine.predict_members(features)
    ens = combine(members, weights)

    home_prob = calibrator.transform_one(ens.home_win_prob)
    home_prob = min(0.99, max(0.01, home_prob))
    away_prob = 1 - home_prob

    odds = game["odds"]
    total_line = float(odds.get("total", {}).get("line", round(ens.predicted_total)))
    over_prob = _norm_sf(total_line, ens.predicted_total, _TOTAL_SIGMA)
    under_prob = 1 - over_prob

    # Run line (-1.5): P(favorite wins by 2+) ≈ P(favorite wins) × share-by-2+.
    fav_win = max(home_prob, away_prob)
    fav_covers = fav_win * _WIN_BY_2_GIVEN_WIN

    ev_bets, headline_edge = _build_ev_bets(
        home_prob, over_prob, game["home"]["abbreviation"], game["away"]["abbreviation"], odds
    )
    market_edge = abs(headline_edge)

    model_outputs = ModelOutputs(
        home_win_prob=home_prob,
        away_win_prob=away_prob,
        run_line_fav_covers=fav_covers,
        run_line_dog_covers=1 - fav_covers,
        predicted_total=ens.predicted_total,
        total_line=total_line,
        over_prob=over_prob,
        under_prob=under_prob,
        ev_bets=ev_bets,
        component_agreement=ens.component_agreement,
        market_edge=market_edge,
    )

    key_factors = [f"{m.name}: home {m.home_win_prob * 100:.0f}%" for m in members]
    key_factors.append(f"predicted total ~{ens.predicted_total:.1f}")

    return GamePrediction(
        game_id=game["gameId"],
        start_time_local=game["startTimeLocal"],
        home_abbr=game["home"]["abbreviation"],
        home_name=game["home"]["name"],
        away_abbr=game["away"]["abbreviation"],
        away_name=game["away"]["name"],
        data=game["data"],
        model=model_outputs,
        confidence=_pre_review_rank(market_edge, ens.component_agreement),
        key_factors=key_factors,
    )


def run_pipeline(
    date: str, config: EngineConfig = DEFAULT_CONFIG
) -> list[GamePrediction]:
    slate = load_slate(date, config)
    engine = PredictionEngine(config)
    weights = load_weights(config.artifacts_dir)
    calibrator = ProbabilityCalibrator.load(config.artifact(CALIBRATOR_FILE))
    return [predict_game(g, engine, weights, calibrator) for g in slate]


def write_predictions(
    date: str, config: EngineConfig = DEFAULT_CONFIG
) -> Path:
    config.ensure_dirs()
    predictions = run_pipeline(date, config)
    out = {
        "date": date,
        "generatedBy": "sportslab-engine",
        "gbmTrained": PredictionEngine(config).has_gbm,
        "predictions": [p.to_review_json() for p in predictions],
    }
    path = config.output(f"predictions_{date}.json")
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return path
