/**
 * Step 3 — Context assembler.
 *
 * Convenience that gathers the four normalized context sources into a single
 * {@link GameContext} for a game. Steps 1–2 (or a fetch layer) produce the
 * normalized parts via the sibling modules; this just packages them and pins
 * ballpark factors from the home-team abbreviation.
 */
import type { CoreGame, GameContext, TeamInjuryReport, TeamRecentForm, Weather } from "../schemas";
import { lookupBallparkFactors } from "./ballpark";

export interface ContextParts {
  recentForm: { home: TeamRecentForm; away: TeamRecentForm };
  injuries: { home: TeamInjuryReport; away: TeamInjuryReport };
  weather: Weather;
}

export function assembleGameContext(game: CoreGame, parts: ContextParts): GameContext {
  return {
    gameId: game.gameId,
    recentForm: parts.recentForm,
    injuries: parts.injuries,
    weather: parts.weather,
    ballpark: lookupBallparkFactors(game.venueId, game.home.abbreviation),
  };
}
