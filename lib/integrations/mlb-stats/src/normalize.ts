/**
 * Turns a raw API game into our domain model, and works out what is wrong with it.
 *
 * This file is where the plan's "fail loudly, not silently" rule (§3) actually
 * lives. Nothing here invents a value: an unannounced starting pitcher stays
 * `null` and raises a flag, rather than being quietly filled with a league
 * average that would then flow into a prediction as if it were real.
 */

import type { ApiGame } from "./api-schema.ts";
import { teamAbbreviation } from "./teams.ts";
import type {
  DataFlag,
  DoubleHeaderKind,
  GameStatus,
  GameType,
  ScheduledGame,
  TeamSide,
} from "./types.ts";

/**
 * Normalise game state.
 *
 * `detailedState` is checked first because it is the only field that
 * distinguishes a postponement from a game that simply has not started — both
 * report `abstractGameState: "Preview"`, and treating a postponed game as
 * predictable would put a prediction on a game that is not being played.
 */
export function normalizeStatus(detailedState: string, abstractGameState: string): GameStatus {
  const detail = detailedState.toLowerCase();

  if (detail.includes("postponed")) return "postponed";
  if (detail.includes("cancel")) return "cancelled";
  if (detail.includes("suspended")) return "suspended";
  if (detail.includes("delayed")) return "delayed";
  if (detail.includes("forfeit")) return "final";

  switch (abstractGameState.toLowerCase()) {
    case "preview":
      // "Pre-Game" and "Warmup" mean the lineup is in and first pitch is close.
      return detail === "scheduled" ? "scheduled" : "pregame";
    case "live":
      return "live";
    case "final":
      return "final";
    default:
      return "unknown";
  }
}

/**
 * MLB's single-letter game type codes.
 *
 * `R` is the only one v1.0 predicts. The rest are recognised so they can be
 * filtered deliberately rather than slipping into a regular-season backtest —
 * spring training in particular looks like baseball but is played by different
 * people under different incentives.
 */
export function normalizeGameType(code: string): GameType {
  switch (code.toUpperCase()) {
    case "R":
      return "regular";
    case "S":
      return "spring";
    case "F": // Wild Card
    case "D": // Division Series
    case "L": // League Championship Series
    case "W": // World Series
    case "C": // Play-in / tiebreaker
    case "P": // Playoffs, unspecified
      return "postseason";
    case "A":
      return "allstar";
    case "E": // Exhibition
    case "I": // Intrasquad
      return "exhibition";
    default:
      return "other";
  }
}

function normalizeDoubleHeader(code: string | undefined): DoubleHeaderKind {
  switch ((code ?? "N").toUpperCase()) {
    case "Y":
      return "traditional";
    case "S":
      return "split";
    default:
      return "none";
  }
}

function normalizeTeamSide(side: ApiGame["teams"]["home"]): TeamSide {
  return {
    id: side.team.id,
    name: side.team.name,
    wins: side.leagueRecord?.wins ?? null,
    losses: side.leagueRecord?.losses ?? null,
    probablePitcher: side.probablePitcher
      ? { id: side.probablePitcher.id, fullName: side.probablePitcher.fullName }
      : null,
    score: side.score ?? null,
  };
}

/** Derives `YYYY-MM-DD` from an ISO timestamp, for the rare game with no `officialDate`. */
function dateFromIso(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso.slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The seed handed to the Monte Carlo simulator.
 *
 * Derived from `gamePk` rather than from teams and date, because the two games
 * of a doubleheader share both of those and would otherwise share a random
 * stream.
 */
export function seedForGame(gamePk: number): string {
  return `mlb:${gamePk}`;
}

export function normalizeGame(game: ApiGame): ScheduledGame {
  const status = normalizeStatus(game.status.detailedState, game.status.abstractGameState);
  const gameType = normalizeGameType(game.gameType);
  const doubleHeader = normalizeDoubleHeader(game.doubleHeader);
  const gameNumber = game.gameNumber ?? 1;
  const scheduledInnings = game.scheduledInnings ?? 9;
  const officialDate = game.officialDate ?? dateFromIso(game.gameDate);
  const startTimeTBD = game.status.startTimeTBD ?? false;

  const home = normalizeTeamSide(game.teams.home);
  const away = normalizeTeamSide(game.teams.away);

  const flags: DataFlag[] = [];

  if (status === "postponed") flags.push("postponed");
  if (status === "cancelled") flags.push("cancelled");
  if (status === "suspended") flags.push("suspended");
  if (status === "delayed") flags.push("delayed");
  if (status === "live") flags.push("in-progress");
  if (status === "final") flags.push("completed");

  if (startTimeTBD) flags.push("start-time-tbd");

  // The starting pitcher is the single biggest driver of a game's outcome
  // (§3), so its absence is the most consequential gap we can have.
  if (!home.probablePitcher) flags.push("missing-home-pitcher");
  if (!away.probablePitcher) flags.push("missing-away-pitcher");

  if (gameType !== "regular") flags.push("non-regular-season");
  if (doubleHeader !== "none") flags.push("doubleheader");
  if (scheduledInnings !== 9) flags.push("shortened-game");
  if (!game.venue) flags.push("missing-venue");
  if (game.resumedFrom) flags.push("resumed-game");

  // Predictable means "worth simulating now". Missing data does not disqualify
  // a game — it makes it a low-confidence prediction, which is the ranking
  // step's decision, not this one's.
  const isPredictable = status === "scheduled" || status === "pregame" || status === "delayed";

  const dayNight =
    game.dayNight === "day" || game.dayNight === "night" ? game.dayNight : null;

  return {
    gamePk: game.gamePk,
    key: `${officialDate}:${teamAbbreviation(away.id, away.name)}@${teamAbbreviation(home.id, home.name)}:g${gameNumber}`,
    seed: seedForGame(game.gamePk),
    gameType,
    season: game.season,
    startTime: game.gameDate,
    officialDate,
    status,
    detailedState: game.status.detailedState,
    statusReason: game.status.reason ?? null,
    home,
    away,
    venue: game.venue ? { id: game.venue.id, name: game.venue.name } : null,
    doubleHeader,
    gameNumber,
    scheduledInnings,
    seriesDescription: game.seriesDescription ?? null,
    dayNight,
    isPredictable,
    flags,
  };
}
