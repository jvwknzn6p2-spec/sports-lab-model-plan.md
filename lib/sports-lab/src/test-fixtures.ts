/**
 * Shared builders for tests. Produces a fully-valid game + context that each
 * test mutates to exercise one failure mode at a time.
 */
import type {
  BullpenStats,
  CoreGame,
  GameContext,
  StartingPitcher,
  TeamBattingStats,
  TeamInjuryReport,
  TeamRecentForm,
  Weather,
} from "./schemas";

const NOW = "2026-07-25T12:00:00Z";
const FIRST_PITCH = "2026-07-25T23:10:00Z";

export const REF_NOW = NOW;
export const REF_FIRST_PITCH = FIRST_PITCH;

function starter(name: string): StartingPitcher {
  return { playerId: `p-${name}`, name, confirmed: true, seasonEra: 3.2, seasonWhip: 1.1, inningsPitched: 120 };
}

function form(teamId: string): TeamRecentForm {
  return {
    teamId,
    sampleSize: 10,
    window: 10,
    wins: 6,
    losses: 4,
    runsScoredPerGame: 4.8,
    runsAllowedPerGame: 4.1,
    fetchedAt: NOW,
  };
}

function injuries(teamId: string): TeamInjuryReport {
  return { teamId, injuries: [], lineupConfirmed: true, fetchedAt: NOW };
}

/** League-average offense, so fixture teams start from a neutral baseline. */
function batting(teamId: string): TeamBattingStats {
  return {
    teamId,
    runsPerGame: 4.4,
    onBasePct: 0.32,
    sluggingPct: 0.41,
    wOBA: 0.32,
    fetchedAt: NOW,
  };
}

/** League-average bullpen with a rested workload. */
function bullpen(teamId: string): BullpenStats {
  return { teamId, era: 4.1, inningsPitchedLast3Days: 4, fetchedAt: NOW };
}

function weather(): Weather {
  return {
    weatherMode: "observed",
    forecastFor: null,
    temperatureF: 78,
    windSpeedMph: 8,
    windRelative: "out",
    precipitationChance: 0.1,
    roofState: "none",
    fetchedAt: NOW,
  };
}

/** A game whose data is complete and clean — validation should return "S". */
export function validGame(): { game: CoreGame; context: GameContext } {
  const game: CoreGame = {
    gameId: "g-1",
    startTime: FIRST_PITCH,
    venueId: "v-hou",
    venueName: "Daikin Park",
    home: { id: "t-hou", name: "Houston Astros", abbreviation: "HOU" },
    away: { id: "t-laa", name: "Los Angeles Angels", abbreviation: "LAA" },
    homeStarter: starter("Framber Valdez"),
    awayStarter: starter("Reid Detmers"),
    homeBatting: batting("t-hou"),
    awayBatting: batting("t-laa"),
    homeBullpen: bullpen("t-hou"),
    awayBullpen: bullpen("t-laa"),
  };
  const context: GameContext = {
    gameId: "g-1",
    recentForm: { home: form("t-hou"), away: form("t-laa") },
    injuries: { home: injuries("t-hou"), away: injuries("t-laa") },
    weather: weather(),
    ballpark: { venueId: "v-hou", runsFactor: 1.0, hrFactor: 1.03, isNeutralFallback: false },
  };
  return { game, context };
}

/**
 * A game where every input sits exactly at league average and the weather is
 * inert (70°F, calm, neutral park). The baseline model should return the
 * league baseline for the away team, and only home-field advantage should
 * separate the two sides — which makes each individual adjustment testable
 * in isolation by perturbing one field at a time.
 */
export function neutralGame(): { game: CoreGame; context: GameContext } {
  const { game, context } = validGame();

  game.homeStarter!.seasonEra = 4.1; // league ERA
  game.awayStarter!.seasonEra = 4.1;
  game.homeBullpen!.inningsPitchedLast3Days = 0; // no fatigue
  game.awayBullpen!.inningsPitchedLast3Days = 0;

  // Recent form exactly matches the season rate → no form adjustment.
  context.recentForm.home.runsScoredPerGame = 4.4;
  context.recentForm.away.runsScoredPerGame = 4.4;

  context.weather = {
    weatherMode: "observed",
    forecastFor: null,
    temperatureF: 70, // reference temperature → no effect
    windSpeedMph: 0,
    windRelative: "calm",
    precipitationChance: 0,
    roofState: "none",
    fetchedAt: REF_NOW,
  };

  return { game, context };
}
