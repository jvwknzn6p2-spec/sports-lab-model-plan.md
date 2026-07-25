/**
 * Stage 1 — Intake Engine.
 *
 * Joins Schedule + Handicap into one validated per-game record and assesses data
 * completeness. "Fail loudly, not silently": missing inputs become explicit
 * `dataIssues` that later drive PASS decisions, never silent fabrication.
 */
import {
  intakeGameSchema,
  type Handicap,
  type IntakeGame,
  type Schedule,
} from "../schemas.js";

const DEFAULT_HANDICAP = -1.5;

export function runIntake(schedule: Schedule, handicap: Handicap): IntakeGame[] {
  const lineById = new Map(handicap.lines.map((l) => [l.gameId, l]));

  return schedule.games.map((game) => {
    const issues: string[] = [];
    if (!game.homePitcher || !game.homePitcher.confirmed) {
      issues.push("home starter not confirmed");
    }
    if (!game.awayPitcher || !game.awayPitcher.confirmed) {
      issues.push("away starter not confirmed");
    }
    if (!game.oddsAvailable) issues.push("odds unavailable");
    if (!game.battingStatsAvailable) issues.push("batting stats missing");
    if (!game.bullpenStatsAvailable) issues.push("bullpen stats missing");

    const line = lineById.get(game.gameId);
    if (!line) issues.push("handicap line missing");

    const record: IntakeGame = {
      gameId: game.gameId,
      startTimeLocal: game.startTimeLocal,
      home: game.home,
      away: game.away,
      schedule: game,
      handicap: line
        ? { favorite: line.favorite, handicap: line.handicap }
        : { favorite: "home", handicap: DEFAULT_HANDICAP },
      dataComplete: issues.length === 0,
      dataIssues: issues,
    };
    return intakeGameSchema.parse(record);
  });
}
