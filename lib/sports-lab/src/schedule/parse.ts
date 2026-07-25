import {
  RawScheduleResponse,
  type DailySchedule,
  type ScheduledGame,
  type TeamSide,
} from "./types";

/**
 * Thrown when the raw schedule payload is structurally invalid — i.e. the
 * fields we depend on are missing or the wrong type. This is the "fail loudly"
 * path: we would rather stop than build a game object out of guesses.
 */
export class ScheduleParseError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = "ScheduleParseError";
    this.issues = issues;
  }
}

export interface ParseScheduleOptions {
  /** Requested slate date, `YYYY-MM-DD`. */
  date: string;
  /** When the pull happened, ISO-8601 UTC. Defaults to now. */
  fetchedAtUtc?: string;
}

function toTeamSide(
  raw: RawScheduleResponse["dates"][number]["games"][number]["teams"]["home"],
  side: "home" | "away",
  flags: string[],
): TeamSide {
  const probablePitcher = raw.probablePitcher
    ? { id: raw.probablePitcher.id, fullName: raw.probablePitcher.fullName }
    : null;

  // Missing starter is legitimate (not yet confirmed), so we flag rather than
  // throw — downstream can downgrade confidence instead of trusting a fake.
  if (probablePitcher === null) {
    flags.push(`missing_probable_pitcher:${side}`);
  }

  return {
    teamId: raw.team.id,
    teamName: raw.team.name,
    probablePitcher,
  };
}

/**
 * Parse a raw MLB Stats API `/api/v1/schedule` response into our clean,
 * storable {@link DailySchedule}.
 *
 * Throws {@link ScheduleParseError} on a structurally broken payload. Games
 * with soft/missing data (e.g. an unconfirmed starter) parse successfully with
 * an entry in `dataFlags`.
 */
export function parseSchedule(
  raw: unknown,
  options: ParseScheduleOptions,
): DailySchedule {
  const result = RawScheduleResponse.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
    );
    throw new ScheduleParseError(
      "MLB schedule payload did not match the expected shape",
      issues,
    );
  }

  const fetchedAtUtc = options.fetchedAtUtc ?? new Date().toISOString();
  const games: ScheduledGame[] = [];

  for (const date of result.data.dates) {
    for (const game of date.games) {
      const dataFlags: string[] = [];
      const home = toTeamSide(game.teams.home, "home", dataFlags);
      const away = toTeamSide(game.teams.away, "away", dataFlags);

      games.push({
        gamePk: game.gamePk,
        gameDateUtc: game.gameDate,
        status: {
          abstract: game.status.abstractGameState,
          detailed: game.status.detailedState,
          coded: game.status.codedGameState,
        },
        venue: { id: game.venue.id, name: game.venue.name },
        home,
        away,
        doubleHeader: game.doubleHeader ?? "N",
        gameNumber: game.gameNumber ?? 1,
        dataFlags,
      });
    }
  }

  return {
    date: options.date,
    fetchedAtUtc,
    source: "mlb-stats-api",
    games,
  };
}
