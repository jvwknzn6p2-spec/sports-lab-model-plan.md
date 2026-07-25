/**
 * Step 4: the baseline statistical model.
 *
 * Expected runs are built multiplicatively from the league average, in the
 * style of a log5 / odds-ratio model:
 *
 *   expected = leagueRunsPerGame
 *            x offenseRating(team)        // how well this lineup hits
 *            x defenseRating(opponent)    // starter + bullpen, innings-weighted
 *            x parkFactor
 *            x weatherFactor
 *            x homeFieldAdvantage
 *            x injuryFactor
 *
 * Every factor is recorded in an `adjustments` trail so the number is readable
 * step by step — the plan's "a beginner can see *why* a team is favoured".
 *
 * Two habits keep this honest:
 *   - Every team/pitcher rate is shrunk toward league average by sample size.
 *     Nothing here trusts a 20-inning ERA at face value.
 *   - Missing inputs fall back to *league average*, never to an optimistic or
 *     pessimistic guess, and the fallback is named in the trail.
 */

import { MLB_CONSTANTS, type ModelConstants } from "../config";
import { clamp, shrink } from "../core/math";
import type {
  BaselineAdjustment,
  BaselineResult,
  BaselineTeamRuns,
  GameContext,
  Side,
  TeamContext,
} from "../core/types";

const OPPOSITE: Record<Side, Side> = { home: "away", away: "home" };

/**
 * Runs per game implied by OBP and SLG, rescaled so that league-average inputs
 * return exactly `leagueRunsPerGame`. This is a second opinion on a team's
 * offense that is less noisy than raw runs scored, which is polluted by
 * opponent quality and sequencing luck.
 */
export function componentRunsPerGame(
  onBasePct: number,
  sluggingPct: number,
  constants: ModelConstants,
): number {
  const w = constants.componentRunWeights;
  const raw = w.onBasePct * onBasePct + w.sluggingPct * sluggingPct + w.intercept;
  const atLeagueAverage =
    w.onBasePct * constants.leagueReference.onBasePct +
    w.sluggingPct * constants.leagueReference.sluggingPct +
    w.intercept;
  if (atLeagueAverage <= 0) return constants.leagueRunsPerGame;
  return constants.leagueRunsPerGame * (raw / atLeagueAverage);
}

/**
 * Combined temperature and wind multiplier on runs.
 *
 * Temperature: warm air is thinner and the ball carries. Wind: only the
 * component along the home-plate-to-center-field axis matters, and only when we
 * know which way the park points. A roofed, closed park gets exactly 1.00.
 */
export function weatherMultiplier(
  context: GameContext,
  constants: ModelConstants,
): { multiplier: number; note: string } {
  const weather = context.weather;
  if (!weather) return { multiplier: 1, note: "no weather data — no adjustment" };
  if (weather.roofClosed) return { multiplier: 1, note: "roof closed — weather neutral" };

  const parts: string[] = [];
  let deviation = 0;

  if (weather.temperatureF !== null) {
    const delta = weather.temperatureF - constants.weather.referenceTempF;
    deviation += constants.weather.perDegreeF * delta;
    parts.push(`${Math.round(weather.temperatureF)}F`);
  }

  const bearing = context.venue.centerFieldBearingDeg;
  if (weather.windMph !== null && weather.windFromDeg !== null && bearing !== null) {
    // Meteorological direction is where wind comes *from*; flip it to get where
    // it blows toward, then project onto the center-field axis.
    const blowsToward = (weather.windFromDeg + 180) % 360;
    const deltaDeg = ((blowsToward - bearing + 540) % 360) - 180;
    const outwardMph = weather.windMph * Math.cos((deltaDeg * Math.PI) / 180);
    deviation += constants.weather.perMphOut * outwardMph;
    const direction = outwardMph >= 0 ? "out" : "in";
    parts.push(`wind ${Math.abs(outwardMph).toFixed(0)}mph ${direction} to CF`);
  } else if (weather.windMph !== null) {
    parts.push(`wind ${weather.windMph.toFixed(0)}mph (direction unusable)`);
  }

  const capped = clamp(deviation, -constants.weather.maxDeviation, constants.weather.maxDeviation);
  return {
    multiplier: 1 + capped,
    note: parts.length > 0 ? parts.join(", ") : "weather present but unusable",
  };
}

/** Offense rating (1.00 = league average) with shrinkage and recent form. */
function offenseRating(
  team: TeamContext,
  constants: ModelConstants,
): { rating: number; notes: string[] } {
  const notes: string[] = [];
  const league = constants.leagueRunsPerGame;
  const offense = team.offense;

  if (!offense || offense.runsPerGame === null) {
    notes.push("no batting data — league average");
    return { rating: 1, notes };
  }

  const games = offense.gamesPlayed;
  const direct = shrink(offense.runsPerGame, league, games, constants.shrink.teamOffenseGames);

  let seasonEstimate = direct;
  if (offense.onBasePct !== null && offense.sluggingPct !== null) {
    const component = componentRunsPerGame(offense.onBasePct, offense.sluggingPct, constants);
    const shrunkComponent = shrink(component, league, games, constants.shrink.teamOffenseGames);
    seasonEstimate = 0.5 * direct + 0.5 * shrunkComponent;
    notes.push(
      `season ${offense.runsPerGame.toFixed(2)} R/G, OBP/SLG implies ${component.toFixed(2)}`,
    );
  } else {
    notes.push(`season ${offense.runsPerGame.toFixed(2)} R/G (no OBP/SLG)`);
  }

  let blended = seasonEstimate;
  const form = team.form;
  if (form && form.runsScoredPerGame !== null && form.games > 0) {
    const weight =
      constants.recentFormWeight * Math.min(1, form.games / constants.recentFormGames);
    blended = (1 - weight) * seasonEstimate + weight * form.runsScoredPerGame;
    notes.push(
      `last ${form.games} games ${form.runsScoredPerGame.toFixed(2)} R/G ` +
        `(weight ${(weight * 100).toFixed(0)}%)`,
    );
  }

  return { rating: blended / league, notes };
}

/**
 * Opponent run-prevention rating (1.00 = league average), weighted by the
 * innings the starter is expected to cover.
 */
function defenseRating(
  opponent: TeamContext,
  constants: ModelConstants,
): { rating: number; starterShare: number; notes: string[] } {
  const notes: string[] = [];
  const leagueRa9 = constants.leagueRunsAllowedPer9;
  const starter = opponent.starter;

  const starterRa9 = starter?.runsAllowedPer9 != null
    ? shrink(
        starter.runsAllowedPer9,
        leagueRa9,
        starter.inningsPitched,
        constants.shrink.starterInnings,
      )
    : leagueRa9;
  if (starter?.runsAllowedPer9 != null) {
    notes.push(
      `${starter.pitcher.fullName} ${starter.runsAllowedPer9.toFixed(2)} RA/9 over ` +
        `${starter.inningsPitched.toFixed(0)} IP -> ${starterRa9.toFixed(2)} regressed`,
    );
  } else {
    notes.push("starter unknown — league-average starter");
  }

  const inningsPerStart = starter?.inningsPerStart != null
    ? shrink(
        starter.inningsPerStart,
        constants.leagueInningsPerStart,
        starter.gamesStarted,
        constants.shrink.inningsPerStartStarts,
      )
    : constants.leagueInningsPerStart;
  const starterShare = clamp(inningsPerStart / 9, 0.2, 0.9);

  const bullpen = opponent.bullpen;
  const bullpenObserved =
    bullpen?.runsAllowedPer9 ?? opponent.pitching?.runsAllowedPer9 ?? null;
  const bullpenSample = bullpen?.reliefInningsPitched ?? opponent.pitching?.inningsPitched ?? 0;
  let bullpenRa9 = shrink(
    bullpenObserved,
    leagueRa9,
    bullpenSample,
    constants.shrink.bullpenInnings,
  );

  const fatigue = bullpen?.fatigueIndex ?? null;
  if (fatigue !== null && fatigue > 0) {
    bullpenRa9 *= 1 + constants.bullpenFatiguePenalty * fatigue;
    notes.push(`bullpen fatigue ${(fatigue * 100).toFixed(0)}%`);
  }
  notes.push(
    `bullpen ${bullpenRa9.toFixed(2)} RA/9 covering ` +
      `${((1 - starterShare) * 9).toFixed(1)} innings`,
  );

  const blendedRa9 = starterShare * starterRa9 + (1 - starterShare) * bullpenRa9;
  return { rating: blendedRa9 / leagueRa9, starterShare, notes };
}

function injuryMultiplier(
  team: TeamContext,
  constants: ModelConstants,
): { multiplier: number; note: string } {
  const injuries = team.injuries;
  if (!injuries) return { multiplier: 1, note: "injury data unavailable" };
  const penalty = Math.min(
    constants.injury.maxPenalty,
    injuries.injuredListCount * constants.injury.perPlayerPenalty,
  );
  return {
    multiplier: 1 - penalty,
    note:
      injuries.injuredListCount === 0
        ? "no players on the IL"
        : `${injuries.injuredListCount} on the IL (count only, not player value)`,
  };
}

function teamRuns(
  side: Side,
  context: GameContext,
  constants: ModelConstants,
): BaselineTeamRuns {
  const team = context.teams[side];
  const opponent = context.teams[OPPOSITE[side]];
  const adjustments: BaselineAdjustment[] = [];
  let runs = constants.leagueRunsPerGame;

  const offense = offenseRating(team, constants);
  runs *= offense.rating;
  adjustments.push({
    name: "offense",
    multiplier: offense.rating,
    note: offense.notes.join("; "),
  });

  const defense = defenseRating(opponent, constants);
  runs *= defense.rating;
  adjustments.push({
    name: "opposing pitching",
    multiplier: defense.rating,
    note: defense.notes.join("; "),
  });

  runs *= context.park.runs;
  adjustments.push({
    name: "ballpark",
    multiplier: context.park.runs,
    note: context.park.matched
      ? `${context.park.venueName} (${context.park.source})`
      : `${context.park.venueName} not in table — neutral`,
  });

  const weather = weatherMultiplier(context, constants);
  runs *= weather.multiplier;
  adjustments.push({ name: "weather", multiplier: weather.multiplier, note: weather.note });

  const hfa =
    side === "home"
      ? constants.homeFieldAdvantage.homeOffense
      : constants.homeFieldAdvantage.awayOffense;
  runs *= hfa;
  adjustments.push({
    name: "home-field advantage",
    multiplier: hfa,
    note: side === "home" ? "batting at home" : "batting on the road",
  });

  const injury = injuryMultiplier(team, constants);
  runs *= injury.multiplier;
  adjustments.push({ name: "injuries", multiplier: injury.multiplier, note: injury.note });

  return {
    expectedRuns: runs,
    leagueBaseline: constants.leagueRunsPerGame,
    adjustments,
    opposingStarterInningsShare: defense.starterShare,
  };
}

export function runBaseline(
  context: GameContext,
  constants: ModelConstants = MLB_CONSTANTS,
): BaselineResult {
  const home = teamRuns("home", context, constants);
  const away = teamRuns("away", context, constants);
  return {
    teams: { home, away },
    expectedTotal: home.expectedRuns + away.expectedRuns,
    expectedMargin: home.expectedRuns - away.expectedRuns,
  };
}
