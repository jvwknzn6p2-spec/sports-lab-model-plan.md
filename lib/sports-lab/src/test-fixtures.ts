/**
 * Shared builders for tests. Produces a fully-valid game + context that each
 * test mutates to exercise one failure mode at a time.
 */
import type {
  CoreGame,
  GameContext,
  StartingPitcher,
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
