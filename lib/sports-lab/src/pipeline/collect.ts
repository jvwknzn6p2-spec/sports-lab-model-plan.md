/**
 * Steps 1-3 of the plan: fetch the schedule, pull every input, and record what
 * is missing.
 *
 * This module is deliberately the only place that knows how many data sources
 * there are. Everything downstream consumes a `GameContext` and never talks to
 * the network.
 */

import { MLB_CONSTANTS, type ModelConstants, type RuntimeConfig } from "../config";
import { nowIso } from "../core/dates";
import { ISSUE_CODES, IssueCollector } from "../core/issues";
import type {
  GameContext,
  GameDate,
  InjuryProfile,
  RecentForm,
  ScheduledGame,
  Side,
  TeamContext,
  TeamRef,
} from "../core/types";
import { HttpClient } from "../sources/http";
import { MlbBullpenSource, MIN_RELIEVERS, fatigueFromSchedule } from "../sources/mlb/bullpen";
import { MlbPitcherSource } from "../sources/mlb/pitchers";
import { MlbScheduleSource, type TeamHistory } from "../sources/mlb/schedule";
import { MlbTeamStatsSource } from "../sources/mlb/teams";
import { MlbVenueSource, unknownVenue } from "../sources/mlb/venues";
import { OddsSource } from "../sources/odds";
import { lookupParkFactor } from "../sources/static/parkFactors";
import { WeatherSource } from "../sources/weather";

export interface SourceBundle {
  http: HttpClient;
  schedule: MlbScheduleSource;
  teams: MlbTeamStatsSource;
  pitchers: MlbPitcherSource;
  bullpens: MlbBullpenSource;
  venues: MlbVenueSource;
  weather: WeatherSource;
  odds: OddsSource;
}

export function createSources(config: RuntimeConfig): SourceBundle {
  const http = new HttpClient(config);
  return {
    http,
    schedule: new MlbScheduleSource(http),
    teams: new MlbTeamStatsSource(http, config.season),
    pitchers: new MlbPitcherSource(http, config.season),
    bullpens: new MlbBullpenSource(http, config.season),
    venues: new MlbVenueSource(http),
    weather: new WeatherSource(http),
    odds: new OddsSource(http, config.oddsApiKey, config.oddsBook),
  };
}

export interface CollectionOutput {
  date: GameDate;
  contexts: GameContext[];
  skipped: { gamePk: number; matchup: string; reason: string }[];
}

/** Run a source call, converting a thrown error into a data issue. */
async function attempt<T>(
  issues: IssueCollector,
  field: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    issues.error(
      ISSUE_CODES.sourceError,
      field,
      `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function formFromHistory(team: TeamRef, history: TeamHistory | undefined): RecentForm | null {
  if (!history || history.games === 0) return null;
  return {
    team,
    games: history.games,
    runsScoredPerGame: history.runsScored / history.games,
    runsAllowedPerGame: history.runsAllowed / history.games,
  };
}

export class Collector {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly sources: SourceBundle,
    private readonly constants: ModelConstants = MLB_CONSTANTS,
  ) {}

  async collect(date: GameDate): Promise<CollectionOutput> {
    const { games } = await this.sources.schedule.scheduledGames(date);
    const skipped: CollectionOutput["skipped"] = [];

    if (games.length === 0) {
      return { date, contexts: [], skipped };
    }

    // One history pass serves recent form and bullpen workload for every team.
    let history = new Map<number, TeamHistory>();
    try {
      history = await this.sources.schedule.recentTeamHistory(
        date,
        this.constants.recentFormGames,
      );
    } catch {
      // Handled per game as a `recent_form_missing` issue.
    }

    const starters = games
      .flatMap((g) => [g.probablePitchers.home, g.probablePitchers.away])
      .filter((p): p is NonNullable<typeof p> => p !== null);
    try {
      await this.sources.pitchers.prefetch(starters);
    } catch {
      // Handled per game.
    }

    const contexts: GameContext[] = [];
    for (const game of games) {
      const matchup = `${game.away.abbrev} @ ${game.home.abbrev}`;
      if (game.status === "Postponed" || game.status === "Cancelled") {
        skipped.push({ gamePk: game.gamePk, matchup, reason: game.status });
        continue;
      }
      try {
        contexts.push(await this.collectGame(game, history));
      } catch (error) {
        skipped.push({
          gamePk: game.gamePk,
          matchup,
          reason: `collection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    return { date, contexts, skipped };
  }

  private async collectGame(
    game: ScheduledGame,
    history: Map<number, TeamHistory>,
  ): Promise<GameContext> {
    const issues = new IssueCollector();

    if (game.abstractState === "Final" || game.abstractState === "Live") {
      issues.warn(
        "retroactive_prediction",
        "game.status",
        `Game is already ${game.abstractState.toLowerCase()} at collection time. ` +
          `Season-to-date inputs include this game's own result, so treat any ` +
          `backtest built from it as optimistic.`,
      );
    }

    const geo =
      (await attempt(issues, "venue", `Venue lookup ${game.venue.name}`, () =>
        this.sources.venues.geo(game.venue.id, game.venue.name),
      )) ?? unknownVenue(game.venue.id, game.venue.name);
    if (geo.latitude === null || geo.longitude === null) {
      issues.warn(
        ISSUE_CODES.venueGeoMissing,
        "venue.coordinates",
        `No coordinates for ${geo.name}; weather cannot be looked up.`,
      );
    }

    const park = lookupParkFactor(geo.name);
    if (!park.matched) {
      issues.warn(
        ISSUE_CODES.parkFactorUnknown,
        "park",
        `"${geo.name}" is not in the park-factor table; using neutral 1.00. ` +
          `Add it to sources/static/parkFactors.ts.`,
      );
    }

    const weather = await attempt(issues, "weather", `Weather for ${geo.name}`, () =>
      this.sources.weather.forGame(geo, game.date, game.gameTimeUtc),
    );
    if (!weather) {
      issues.warn(
        ISSUE_CODES.weatherMissing,
        "weather",
        "No first-pitch weather; temperature and wind adjustments are skipped.",
      );
    } else if (!weather.roofClosed && weather.windFromDeg !== null && geo.centerFieldBearingDeg === null) {
      issues.info(
        "park_orientation_unknown",
        "venue.centerFieldBearingDeg",
        `Wind speed is known but ${geo.name}'s orientation is not, so wind ` +
          `direction cannot be resolved into out/in. Wind effect skipped.`,
      );
    }

    let odds = null;
    if (!this.sources.odds.enabled) {
      issues.warn(
        ISSUE_CODES.oddsKeyMissing,
        "odds",
        "ODDS_API_KEY is not set. Probabilities are still produced, but there " +
          "is no market to compare against, so no EV and no S/A rank.",
      );
    } else {
      odds = await attempt(issues, "odds", "Odds lookup", () =>
        this.sources.odds.forGame(game),
      );
      if (!odds) {
        issues.warn(ISSUE_CODES.oddsMissing, "odds", "No odds matched this game.");
      } else {
        if (!odds.moneyline) {
          issues.info(ISSUE_CODES.oddsMarketMissing, "odds.moneyline", "No moneyline priced.");
        }
        if (!odds.total) {
          issues.info(ISSUE_CODES.oddsMarketMissing, "odds.total", "No total priced.");
        }
        if (!odds.runLine) {
          issues.info(ISSUE_CODES.oddsMarketMissing, "odds.runLine", "No run line priced.");
        }
      }
    }

    const teams = {} as Record<Side, TeamContext>;
    for (const side of ["home", "away"] as Side[]) {
      teams[side] = await this.collectTeam(side, game, history, issues);
    }

    return {
      sport: "MLB",
      gamePk: game.gamePk,
      date: game.date,
      gameTimeUtc: game.gameTimeUtc,
      status: game.status,
      venue: geo,
      park,
      weather,
      odds,
      teams,
      issues: issues.list(),
      collectedAt: nowIso(),
    };
  }

  private async collectTeam(
    side: Side,
    game: ScheduledGame,
    history: Map<number, TeamHistory>,
    issues: IssueCollector,
  ): Promise<TeamContext> {
    const team = game[side];
    const teamHistory = history.get(team.id);

    const offense = await attempt(issues, `${side}.offense`, `${team.abbrev} batting`, () =>
      this.sources.teams.offense(team),
    );
    if (!offense || offense.runsPerGame === null) {
      issues.error(
        ISSUE_CODES.offenseMissing,
        `${side}.offense`,
        `No season batting line for ${team.name}.`,
      );
    } else if (offense.gamesPlayed < 15) {
      issues.warn(
        ISSUE_CODES.smallSample,
        `${side}.offense`,
        `${team.name} has only ${offense.gamesPlayed} games; batting numbers are ` +
          `heavily regressed toward league average.`,
      );
    }

    const pitching = await attempt(issues, `${side}.pitching`, `${team.abbrev} pitching`, () =>
      this.sources.teams.pitching(team),
    );

    const fatigue = teamHistory
      ? fatigueFromSchedule(teamHistory.gamesLast3Days, teamHistory.extraInningGamesLast3Days)
      : null;
    const bullpen = await attempt(issues, `${side}.bullpen`, `${team.abbrev} bullpen`, () =>
      this.sources.bullpens.profile(team, fatigue),
    );
    if (!bullpen || bullpen.runsAllowedPer9 === null) {
      issues.warn(
        ISSUE_CODES.bullpenMissing,
        `${side}.bullpen`,
        `No bullpen aggregate for ${team.name}; falling back to team pitching.`,
      );
    } else if (bullpen.pitcherCount < MIN_RELIEVERS) {
      issues.warn(
        ISSUE_CODES.smallSample,
        `${side}.bullpen`,
        `Only ${bullpen.pitcherCount} qualifying relievers for ${team.name}.`,
      );
    }

    const form = formFromHistory(team, teamHistory);
    if (!form) {
      issues.info(
        ISSUE_CODES.formMissing,
        `${side}.form`,
        `No completed games in the last ${this.constants.recentFormGames} days for ${team.name}.`,
      );
    }

    const injuredNames = await attempt(issues, `${side}.injuries`, `${team.abbrev} roster`, () =>
      this.sources.teams.injuredPlayers(team),
    );
    const injuries: InjuryProfile | null =
      injuredNames === null
        ? null
        : { team, injuredListCount: injuredNames.length, injuredPlayers: injuredNames };
    if (!injuries) {
      issues.info(
        ISSUE_CODES.injuriesMissing,
        `${side}.injuries`,
        `Injured-list status unavailable for ${team.name}.`,
      );
    }

    const probable = game.probablePitchers[side];
    let starter = null;
    if (!probable) {
      issues.warn(
        ISSUE_CODES.starterUnconfirmed,
        `${side}.starter`,
        `${team.name} has not announced a starter. The rotation slot is modelled ` +
          `as a league-average starter and confidence is capped.`,
      );
    } else {
      starter = await attempt(issues, `${side}.starter`, `${probable.fullName} stats`, () =>
        this.sources.pitchers.seasonStats(probable),
      );
      if (!starter || starter.runsAllowedPer9 === null) {
        issues.warn(
          ISSUE_CODES.starterStatsMissing,
          `${side}.starter`,
          `No ${this.config.season} season line for ${probable.fullName} ` +
            `(debut, or a mid-season move). Modelled as league average.`,
        );
        starter = null;
      } else if (starter.inningsPitched < 20) {
        issues.warn(
          ISSUE_CODES.smallSample,
          `${side}.starter`,
          `${probable.fullName} has only ${starter.inningsPitched.toFixed(1)} innings; ` +
            `heavily regressed.`,
        );
      }
    }

    return { team, offense, pitching, bullpen, form, injuries, starter };
  }
}
