"""Daily slate service — the Feature Engineering front stage of the pipeline.

Turns a real MLB date into the engine's entry contract: fetch the day's slate
(schedule + probable starters), pull each starter's season ERA/WHIP and each
team's season wOBA, engineer the model feature vector, and assemble a validated
:class:`ControlTowerPayload`. The existing pipeline
(prediction -> calibration -> AI review -> lock -> settlement -> ...) then runs
unchanged on that payload.

Design rules (from the model plan):
- **Never fabricate.** A missing probable pitcher or season line is left absent
  and recorded in ``missing_features`` — never filled with a league-average guess.
- **Core-signal completeness.** ``feature_summary.completeness`` reflects the
  features the daily-v1 model actually leans on (starters + team offense). Bullpen,
  park, weather, and market odds are *enhancers*: their absence is surfaced (and
  flagged by the AI Data Auditor) but does not by itself void a prediction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol

from app.core.clock import utc_now
from app.core.enums import (
    ControlTowerStatus,
    DataQualityStatus,
    League,
    Sport,
    ValidationStatus,
)
from app.domain.prediction.features import FEATURE_NAMES
from app.infrastructure.data_sources.mlb_live import (
    MlbLiveFeed,
    PitcherSeason,
    SlateGame,
    TeamHittingSeason,
)
from app.schemas.control_tower import (
    LEAGUE_SCOPE_MAP,
    ControlTowerGame,
    ControlTowerPayload,
    EvidenceRef,
    GameFeatureSummary,
    ProbableStarter,
    SourceFreshness,
)

# The features the daily-v1 pipeline treats as CORE signal (drive completeness).
_CORE_FEATURES: tuple[str, ...] = (
    "home_starter_era",
    "away_starter_era",
    "home_starter_whip",
    "away_starter_whip",
    "home_team_woba",
    "away_team_woba",
)


class OddsLookup(Protocol):
    """Vig-free implied home win probability for a game, or None."""

    def __call__(self, game: SlateGame) -> float | None: ...


class WeatherLookup(Protocol):
    """(temp_f, wind_mph) for a game's venue, or (None, None)."""

    def __call__(self, game: SlateGame) -> tuple[float | None, float | None]: ...


@dataclass(frozen=True)
class DailySlateResult:
    payload: ControlTowerPayload
    games_found: int
    games_included: int
    skipped_reasons: tuple[str, ...]


class DailySlateService:
    def __init__(
        self,
        feed: MlbLiveFeed,
        schema_version: str = "1.0.0",
        odds_lookup: OddsLookup | None = None,
        weather_lookup: WeatherLookup | None = None,
    ) -> None:
        self._feed = feed
        self._schema_version = schema_version
        self._odds = odds_lookup
        self._weather = weather_lookup

    def build_payload(
        self, target_date: date, league: League = League.MLB, season: int | None = None
    ) -> DailySlateResult:
        season = season or target_date.year
        slate = self._feed.fetch_slate(target_date)

        # Batch the season-stat fetches for the whole slate.
        pitcher_ids = [
            pid
            for g in slate
            for pid in (g.home_starter.pitcher_id, g.away_starter.pitcher_id)
            if pid
        ]
        pitchers = self._feed.fetch_pitcher_seasons(pitcher_ids, season)
        team_ids = {tid for g in slate for tid in (g.home_team_id, g.away_team_id) if tid}
        team_hitting = {tid: self._feed.fetch_team_hitting(tid, season) for tid in team_ids}

        generated_at = utc_now()
        games: list[ControlTowerGame] = []
        skipped: list[str] = []
        for g in slate:
            ct_game = self._build_game(g, pitchers, team_hitting, league)
            if ct_game is None:
                skipped.append(f"{g.game_pk}: could not build (missing teams)")
                continue
            games.append(ct_game)

        # A valid payload needs at least one game; deadline must be >= generated_at.
        deadline = generated_at + timedelta(hours=12)
        latest_start = max((g.scheduled_start for g in slate if g.scheduled_start), default=None)
        if latest_start is not None and latest_start > deadline:
            deadline = latest_start

        overall_completeness = (
            sum(gm.feature_summary.completeness or 0.0 for gm in games) / len(games)
            if games
            else 0.0
        )
        dq = (
            DataQualityStatus.OK
            if overall_completeness >= 0.9
            else DataQualityStatus.DEGRADED
            if overall_completeness >= 0.5
            else DataQualityStatus.INSUFFICIENT
        )

        payload = ControlTowerPayload(
            schema_version=self._schema_version,
            run_id=f"daily-{league.value}-{target_date.isoformat()}",
            league=league,
            sport=Sport.BASEBALL,
            slate_date=target_date,
            timezone="UTC",
            generated_at=generated_at,
            prediction_deadline=deadline,
            settlement_scope=LEAGUE_SCOPE_MAP[league],
            data_quality_status=dq,
            control_tower_status=ControlTowerStatus.PASS,
            source_freshness=SourceFreshness(
                schedule_fetched_at=generated_at,
                odds_fetched_at=generated_at if self._odds else None,
                weather_fetched_at=generated_at if self._weather else None,
            ),
            games=games
            or [self._placeholder_game(target_date, league)],  # keep schema valid on empty slates
        )
        return DailySlateResult(
            payload=payload,
            games_found=len(slate),
            games_included=len(games),
            skipped_reasons=tuple(skipped),
        )

    # ------------------------------------------------------------------ #

    def _build_game(
        self,
        g: SlateGame,
        pitchers: dict[str, PitcherSeason],
        team_hitting: dict[str, TeamHittingSeason],
        league: League,
    ) -> ControlTowerGame | None:
        if not g.home_team or not g.away_team or g.home_team == g.away_team:
            return None

        engineered, missing = self._engineer(g, pitchers, team_hitting)
        core_present = sum(1 for f in _CORE_FEATURES if f in engineered)
        completeness = round(core_present / len(_CORE_FEATURES), 4)

        home_sp = pitchers.get(g.home_starter.pitcher_id or "")
        away_sp = pitchers.get(g.away_starter.pitcher_id or "")
        starters = [
            ProbableStarter(
                team=g.home_team,
                name=g.home_starter.name or (home_sp.name if home_sp else None),
                confirmed=g.home_starter.pitcher_id is not None,
            ),
            ProbableStarter(
                team=g.away_team,
                name=g.away_starter.name or (away_sp.name if away_sp else None),
                confirmed=g.away_starter.pitcher_id is not None,
            ),
        ]
        both_starters = all(s.confirmed for s in starters)

        odds_prob = self._odds(g) if self._odds else None
        temp_f, wind_mph = self._weather(g) if self._weather else (None, None)

        market_summary = (
            {"implied_home_win_probability": odds_prob} if odds_prob is not None else {}
        )
        # Surface team-offense availability so the AI Data Auditor sees it (wOBA is
        # engineered into feature_summary; mirror a marker into lineup_summary).
        lineup_summary: dict = {}
        if "home_team_woba" in engineered:
            lineup_summary["home_team_woba"] = engineered["home_team_woba"]
        if "away_team_woba" in engineered:
            lineup_summary["away_team_woba"] = engineered["away_team_woba"]
        weather_summary: dict = {}
        if temp_f is not None:
            weather_summary["temp_f"] = temp_f
        if wind_mph is not None:
            weather_summary["wind_mph"] = wind_mph

        evidence = [
            EvidenceRef(ref_id=f"schedule-{g.game_pk}", kind="SCHEDULE", quality="OK"),
        ]
        if home_sp or away_sp:
            evidence.append(
                EvidenceRef(ref_id=f"pitchers-{g.game_pk}", kind="PITCHER_SEASON", quality="OK")
            )

        feature_summary = GameFeatureSummary(
            feature_snapshot_id=f"fs-{g.game_pk}",
            completeness=completeness,
            missing_features=missing,
            **engineered,
        )

        return ControlTowerGame(
            match_id=f"{league.value}-{g.game_date.isoformat()}-{g.game_pk}",
            official_game_id=g.game_pk,
            listed_team=g.home_team,
            opponent=g.away_team,
            home=g.home_team,
            away=g.away_team,
            home_away_status="HOME",
            validation_status=ValidationStatus.VALIDATED,
            scheduled_start=g.scheduled_start,
            probable_or_confirmed_starters=starters,
            starter_status="CONFIRMED" if both_starters else "PROJECTED",
            odds_summary={},
            market_summary=market_summary,
            weather_summary=weather_summary,
            lineup_summary=lineup_summary,
            bullpen_summary={},
            feature_summary=feature_summary,
            risk_summary={"critical_flags": []},
            evidence=evidence,
        )

    def _engineer(
        self,
        g: SlateGame,
        pitchers: dict[str, PitcherSeason],
        team_hitting: dict[str, TeamHittingSeason],
    ) -> tuple[dict[str, float], list[str]]:
        home_sp = pitchers.get(g.home_starter.pitcher_id or "")
        away_sp = pitchers.get(g.away_starter.pitcher_id or "")
        home_bat = team_hitting.get(g.home_team_id or "")
        away_bat = team_hitting.get(g.away_team_id or "")

        candidates: dict[str, float | None] = {
            "home_starter_era": home_sp.era if home_sp else None,
            "away_starter_era": away_sp.era if away_sp else None,
            "home_starter_whip": home_sp.whip if home_sp else None,
            "away_starter_whip": away_sp.whip if away_sp else None,
            "home_team_woba": home_bat.woba if home_bat else None,
            "away_team_woba": away_bat.woba if away_bat else None,
            # Enhancers not sourced by the daily-v1 feed (recorded as missing).
            "home_bullpen_era": None,
            "away_bullpen_era": None,
            "home_bullpen_rest_days": None,
            "away_bullpen_rest_days": None,
            "park_factor": None,
            "temp_f": None,
            "wind_mph": None,
            "implied_home_win_probability": None,
        }
        engineered = {k: float(v) for k, v in candidates.items() if v is not None}
        missing = [name for name in FEATURE_NAMES if name not in engineered]
        return engineered, missing

    def _placeholder_game(self, target_date: date, league: League) -> ControlTowerGame:
        """An explicit BLOCKED-quality placeholder so an empty slate still yields a
        schema-valid, clearly-flagged payload rather than an exception."""

        return ControlTowerGame(
            match_id=f"{league.value}-{target_date.isoformat()}-NO-GAMES",
            listed_team="NONE",
            opponent="TBD",
            home="NONE",
            away="TBD",
            validation_status=ValidationStatus.UNVALIDATED,
            feature_summary=GameFeatureSummary(
                completeness=0.0, missing_features=list(FEATURE_NAMES)
            ),
            risk_summary={"critical_flags": ["NO_GAMES_ON_SLATE"]},
        )
