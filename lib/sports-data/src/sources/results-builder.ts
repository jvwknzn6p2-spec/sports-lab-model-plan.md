/**
 * Results builder — turns the post-game schedule pull into a results payload.
 *
 * Only games the API marks Final (with both scores present) are settled;
 * anything still in progress, postponed, or missing scores lands in `pending`
 * with a reason. Settlement therefore never scores a live or suspended game —
 * rerun fetch-results later to pick up stragglers.
 */

import type { MlbStatsClient } from "../mlb/client";
import { normalizeSchedule } from "../mlb/parse";
import type { GameResult } from "../engine/settle";

export interface PendingGame {
  gamePk: number;
  matchup: string;
  reason: string;
}

export interface ResultsBuildReport {
  date: string;
  results: Record<string, GameResult>;
  finals: number;
  pending: PendingGame[];
}

export async function buildResults(opts: {
  date: string;
  client: MlbStatsClient;
}): Promise<ResultsBuildReport> {
  const { date, client } = opts;
  // Schedule failure throws loudly — nothing to settle without it.
  const games = normalizeSchedule(await client.scheduleResults(date));

  const results: Record<string, GameResult> = {};
  const pending: PendingGame[] = [];

  for (const g of games) {
    const matchup = `${g.away.teamName ?? "?"} @ ${g.home.teamName ?? "?"}`;
    if (g.abstractState !== "Final") {
      pending.push({
        gamePk: g.gamePk,
        matchup,
        reason: `not final (${g.status ?? g.abstractState ?? "unknown state"})`,
      });
      continue;
    }
    if (g.home.score === null || g.away.score === null) {
      pending.push({
        gamePk: g.gamePk,
        matchup,
        reason: "final but scores missing from feed",
      });
      continue;
    }
    results[String(g.gamePk)] = {
      homeScore: g.home.score,
      awayScore: g.away.score,
    };
  }

  return {
    date,
    results,
    finals: Object.keys(results).length,
    pending,
  };
}
