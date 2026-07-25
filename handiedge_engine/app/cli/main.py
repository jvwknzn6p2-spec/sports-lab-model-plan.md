"""HandiEdge command-line interface.

The CLI calls the exact same application services as the API — no business logic
is duplicated here.
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

from app.core.config import get_settings
from app.infrastructure.database.session import session_scope
from app.infrastructure.model_adapters.registry import get_adapter
from app.schemas.control_tower import ControlTowerPayload
from app.schemas.learning import LearningWorkflowCreate
from app.schemas.settlement import SettlementInput
from app.services.control_tower_validation_service import ControlTowerValidationService
from app.services.error_analysis_service import ErrorAnalysisService
from app.services.orchestration_service import OrchestrationService
from app.services.prediction_lock_service import PredictionLockService
from app.services.self_learning_service import SelfLearningService
from app.services.settlement_service import SettlementService

app = typer.Typer(help="HandiEdge Engine CLI", no_args_is_help=True)


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _emit(obj) -> None:
    typer.echo(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


@app.command("validate-control-tower")
def validate_control_tower(input_file: Path) -> None:
    """Validate a Control Tower JSON payload without persisting predictions."""

    raw = _load_json(input_file)
    payload = ControlTowerPayload.model_validate(raw)
    with session_scope() as session:
        service = ControlTowerValidationService(session, get_settings().max_games_per_run)
        validated = service.validate(raw)
    _emit(
        {
            "status": "VALID",
            "run_id": payload.run_id,
            "league": payload.league.value,
            "games": len(payload.games),
            "payload_hash": validated.payload_hash,
        }
    )


@app.command("predict")
def predict(input_file: Path) -> None:
    """Run the full validate -> predict -> calibrate -> decide pipeline."""

    raw = _load_json(input_file)
    settings = get_settings()
    with session_scope() as session:
        service = OrchestrationService(session, settings, get_adapter("default"))
        response = service.run_pipeline(raw, correlation_id="cli")
    _emit(response.model_dump(mode="json"))


@app.command("ai-review")
def ai_review(prediction_id: str) -> None:
    """Show the AI multi-agent review (Step 9) recorded for a prediction."""

    from app.repositories.prediction_repository import PredictionRepository

    with session_scope() as session:
        record = PredictionRepository(session).get_prediction(prediction_id)
        if record is None:
            typer.echo(
                json.dumps({"error": "prediction_not_found", "prediction_id": prediction_id})
            )
            raise typer.Exit(code=1)
        final = record.final_prediction or {}
        review = final.get("ai_review")
    if review is None:
        _emit(
            {
                "prediction_id": prediction_id,
                "match_id": final.get("match_id"),
                "ai_review": None,
                "note": "AI review was not run for this prediction.",
            }
        )
        return
    _emit(
        {
            "prediction_id": prediction_id,
            "match_id": final.get("match_id"),
            "confidence_tier": final.get("confidence_tier"),
            "ai_review": review,
        }
    )


@app.command("daily")
def daily(
    target_date: str = typer.Option(
        None, "--date", help="Slate date YYYY-MM-DD (default: today, UTC)."
    ),
    league: str = typer.Option("MLB", help="League: MLB or NPB."),
    season: int = typer.Option(None, help="Season for season stats (default: date's year)."),
    cache_dir: str = typer.Option(None, help="Optional on-disk cache dir for API responses."),
    as_json: bool = typer.Option(False, "--json", help="Emit raw prediction JSON, not the report."),
) -> None:
    """Generate real daily MLB predictions from the live MLB Stats API.

    Runs the full pipeline: Feature Engineering (schedule + season stats) ->
    Prediction -> Calibration -> AI review -> decision, and prints a daily report.
    """

    from datetime import date as _date

    from app.core.clock import utc_now
    from app.core.enums import League
    from app.domain.report.daily import render_daily_report
    from app.infrastructure.data_sources.mlb_live import MlbLiveFeed
    from app.services.daily_slate_service import DailySlateService

    slate_date = _date.fromisoformat(target_date) if target_date else utc_now().date()
    settings = get_settings()
    feed = MlbLiveFeed(cache_dir=cache_dir)
    builder = DailySlateService(feed, schema_version=settings.schema_version)
    result = builder.build_payload(slate_date, league=League(league), season=season)

    with session_scope() as session:
        service = OrchestrationService(session, settings, get_adapter("default"))
        response = service.run_pipeline(
            result.payload.model_dump(mode="json"), correlation_id="daily-cli"
        )

    if as_json:
        _emit(response.model_dump(mode="json"))
    else:
        typer.echo(render_daily_report(response))
        if result.games_included == 0:
            typer.echo("\n(no games on this slate)")


@app.command("lock")
def lock(prediction_id: str, supersede: bool = typer.Option(False)) -> None:
    """Lock a prediction, making it immutable."""

    settings = get_settings()
    with session_scope() as session:
        service = PredictionLockService(session, settings)
        response = service.lock(prediction_id, supersede=supersede, correlation_id="cli")
    _emit(response.model_dump(mode="json"))


@app.command("settle")
def settle(settlement_input: Path) -> None:
    """Settle a locked prediction from an official-result JSON file."""

    raw = _load_json(settlement_input)
    si = SettlementInput.model_validate(raw)
    settings = get_settings()
    with session_scope() as session:
        service = SettlementService(session, settings)
        response = service.settle(si, correlation_id="cli")
    _emit(response.model_dump(mode="json"))


@app.command("analyze-error")
def analyze_error(settlement_id: str) -> None:
    """Generate error analysis for a settlement."""

    settings = get_settings()
    with session_scope() as session:
        service = ErrorAnalysisService(session, settings)
        response = service.analyze_settlement(settlement_id, correlation_id="cli")
    _emit(response.model_dump(mode="json"))


@app.command("create-learning-workflow")
def create_learning_workflow(
    settlement_id: str,
    league: str = typer.Option("MLB"),
    season_segment: str | None = typer.Option(None),
) -> None:
    """Create a self-learning workflow from a settlement."""

    settings = get_settings()
    with session_scope() as session:
        service = SelfLearningService(session, settings)
        response = service.create(
            LearningWorkflowCreate(
                settlement_id=settlement_id, league=league, season_segment=season_segment
            ),
            correlation_id="cli",
        )
    _emit(response.model_dump(mode="json"))


if __name__ == "__main__":  # pragma: no cover
    app()
