/**
 * Lineup-weighted offense — the posted nine instead of the season roster.
 *
 * Team-season wOBA describes everyone who batted for the team all year,
 * including players who are hurt, traded, resting, or in Triple-A tonight.
 * Once the actual lineup is posted, the honest offense estimate is the
 * weighted wOBA of the nine players who will actually bat, weighted by how
 * often each lineup slot comes to the plate (the leadoff hitter gets ~15%
 * more PA than the nine hole).
 *
 * Honesty rules, same as everywhere else:
 *   - No lineup posted → no lineup features. The team-season baseline stays,
 *     with an info flag saying so. Nothing is guessed from "probable" or
 *     "projected" lineups.
 *   - A posted lineup that isn't the full nine, or players whose season line
 *     cannot be fetched, degrade explicitly: each missing bat is filled with
 *     LEAGUE-average wOBA at zero sample (the least-assuming prior) and
 *     flagged, and reliability drops accordingly.
 *   - Every player's wOBA is regressed toward league mean by their own PA —
 *     a September call-up's hot week does not get quoted at face value.
 */

import {
  computeBattingMetrics,
  getLeagueConstants,
  type RawBattingLine,
} from "../sabermetrics";
import { reliabilityWeight, type DataQualityFlag } from "./types";

/**
 * Share of a team's plate appearances by batting-order slot, 1 through 9.
 * Built from the standard ~0.11 PA/game drop per slot from a ~4.65 PA/game
 * leadoff spot; normalized so the shares sum to 1. The gradient, not the
 * absolute level, is what matters here — absolute PA/game comes from the
 * team's own record in team-batting.ts.
 */
export const LINEUP_SLOT_PA_SHARE: readonly number[] = (() => {
  const perGame = Array.from({ length: 9 }, (_, i) => 4.65 - 0.11 * i);
  const total = perGame.reduce((a, b) => a + b, 0);
  return perGame.map((v) => v / total);
})();

/**
 * PA-of-prior for regressing ONE hitter's wOBA toward league mean. Individual
 * hitters stabilize far slower than a pooled team line (team-batting uses
 * 600 PA against a ~5,000 PA season); 250 PA is the conventional
 * stabilization neighborhood for wOBA-shaped rates.
 */
export const PLAYER_WOBA_PRIOR_PA = 250;

export interface LineupSlot {
  playerId: number;
  name: string | null;
}

/** One game side's posted batting order (index 0 = leadoff). */
export interface GameLineups {
  home: LineupSlot[];
  away: LineupSlot[];
}

export interface LineupPlayerInput {
  playerId: number;
  name: string | null;
  /** Season hitting line; null when the fetch failed or found nothing. */
  line: RawBattingLine | null;
}

export interface LineupBattingFeatures {
  /** Slot-share-weighted, per-player-regressed wOBA of the posted nine. */
  projectedWoba: number;
  /** Share-weighted reliability of the individual samples (0–1). */
  reliability: number;
  /** Players whose season line was actually found. */
  playersWithData: number;
  players: Array<{
    playerId: number;
    name: string | null;
    projectedWoba: number;
    pa: number;
  }>;
  flags: DataQualityFlag[];
}

/**
 * Fold a posted nine into one offense number. Returns null when the lineup
 * is not the full nine — a partial post is treated as not posted, because
 * weighting seven bats as if they were the whole order misstates both the
 * lineup and the uncertainty.
 */
export function buildLineupBattingFeatures(opts: {
  season: number;
  players: LineupPlayerInput[];
}): LineupBattingFeatures | null {
  if (opts.players.length !== 9) return null;
  const c = getLeagueConstants(opts.season);
  const flags: DataQualityFlag[] = [];
  const players: LineupBattingFeatures["players"] = [];
  let woba = 0;
  let reliability = 0;
  let withData = 0;

  for (let i = 0; i < 9; i++) {
    const p = opts.players[i]!;
    const share = LINEUP_SLOT_PA_SHARE[i]!;
    let pa = 0;
    let observed = c.wOBA;
    if (p.line) {
      const m = computeBattingMetrics(p.line, opts.season);
      if (m.woba !== null) {
        pa = m.plateAppearances;
        observed = m.woba;
        withData++;
      }
    }
    const projected =
      (pa * observed + PLAYER_WOBA_PRIOR_PA * c.wOBA) /
      (pa + PLAYER_WOBA_PRIOR_PA);
    woba += share * projected;
    reliability += share * reliabilityWeight(pa, PLAYER_WOBA_PRIOR_PA);
    players.push({
      playerId: p.playerId,
      name: p.name,
      projectedWoba: round3(projected),
      pa,
    });
  }

  if (withData < 9) {
    flags.push({
      code: "lineup_bats_missing_stats",
      severity: "warn",
      message:
        `${9 - withData} of 9 posted batters have no season line — ` +
        `filled at league-average wOBA, reliability reduced.`,
    });
  }

  return {
    projectedWoba: round3(woba),
    reliability: round2(reliability),
    playersWithData: withData,
    players,
    flags,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
