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
