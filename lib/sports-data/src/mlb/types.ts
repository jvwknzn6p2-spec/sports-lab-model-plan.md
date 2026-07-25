/**
 * Minimal typings for the subset of the public MLB Stats API
 * (https://statsapi.mlb.com/api/v1) that Step 2 consumes.
 *
 * Only the fields the pipeline reads are modeled; the API returns much more.
 * Everything is optional/defensive because the feed is external and can change
 * or omit fields — the parsers fail loudly on missing *required* values rather
 * than trusting the shape here.
 */

export interface MlbTeamRef {
  id: number;
  name?: string;
  abbreviation?: string;
}

export interface MlbPersonRef {
  id: number;
  fullName?: string;
}

/** /schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher */
export interface MlbScheduleResponse {
  dates?: Array<{
    date?: string;
    games?: MlbScheduleGame[];
  }>;
}

export interface MlbScheduleGame {
  gamePk: number;
  gameDate?: string;
  /** abstractGameState is "Preview" | "Live" | "Final" on the live API. */
  status?: { detailedState?: string; abstractGameState?: string };
  teams?: {
    home?: MlbScheduleGameSide;
    away?: MlbScheduleGameSide;
  };
  venue?: { id?: number; name?: string };
}

export interface MlbScheduleGameSide {
  team?: MlbTeamRef;
  probablePitcher?: MlbPersonRef;
  /** Runs scored — present once the game is underway/final. */
  score?: number;
}

/** /game/{gamePk}/boxscore — only the pitching-usage slice we read. */
export interface MlbBoxscoreResponse {
  teams?: {
    home?: MlbBoxscoreTeam;
    away?: MlbBoxscoreTeam;
  };
}

export interface MlbBoxscoreTeam {
  team?: MlbTeamRef;
  /** Keyed "ID<personId>"; per-game stat lines for everyone who appeared. */
  players?: Record<string, MlbBoxscorePlayer>;
}

export interface MlbBoxscorePlayer {
  person?: MlbPersonRef;
  stats?: {
    pitching?: {
      inningsPitched?: string | number;
      gamesStarted?: number;
    };
  };
}

/** Generic stats envelope used by people/team stats endpoints. */
export interface MlbStatsResponse {
  stats?: Array<{
    group?: { displayName?: string };
    type?: { displayName?: string };
    splits?: Array<{
      season?: string;
      team?: MlbTeamRef;
      player?: MlbPersonRef;
      stat?: Record<string, unknown>;
    }>;
  }>;
}
