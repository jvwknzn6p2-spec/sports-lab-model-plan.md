/**
 * Starting pitchers — the single biggest driver of a game's outcome.
 *
 * All of a slate's probable starters are fetched in one batched `/people` call.
 * A pitcher with no season line yet (a debut, or a trade with missing data)
 * comes back as `null`; the collector turns that into a data issue rather than
 * inventing a league-average arm.
 */

import { SOURCE_URLS } from "../../config";
import type { PitcherRef, PitcherSeason } from "../../core/types";
import type { HttpClient } from "../http";
import {
  parseInningsPitched,
  peopleEnvelopeSchema,
  per9,
  statNumber,
} from "./parse";

export class MlbPitcherSource {
  private readonly cache = new Map<number, PitcherSeason | null>();

  constructor(
    private readonly http: HttpClient,
    private readonly season: number,
  ) {}

  /**
   * Warm the cache for a whole slate. Returns nothing; call `seasonStats()` per
   * pitcher afterwards.
   */
  async prefetch(pitchers: PitcherRef[]): Promise<void> {
    const missing = pitchers.filter((p) => !this.cache.has(p.id));
    if (missing.length === 0) return;
    const ids = [...new Set(missing.map((p) => p.id))].sort((a, b) => a - b);
    // Chunked so the URL stays a sane length even for a 15-game slate.
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      await this.loadChunk(chunk);
    }
    for (const pitcher of missing) {
      if (!this.cache.has(pitcher.id)) this.cache.set(pitcher.id, null);
    }
  }

  private async loadChunk(ids: number[]): Promise<void> {
    const outcome = await this.http.getJson<unknown>(`${SOURCE_URLS.mlbStatsApi}/people`, {
      cacheKey: `mlb/pitchers/${this.season}-${ids.join("_")}`,
      label: `MLB pitcher season stats (${ids.length} pitchers)`,
      ttlSeconds: 6 * 60 * 60,
      query: {
        personIds: ids.join(","),
        hydrate: `stats(group=[pitching],type=[season],season=${this.season},gameType=[R])`,
      },
    });
    const parsed = peopleEnvelopeSchema.safeParse(outcome.body);
    if (!parsed.success) return;
    for (const person of parsed.data.people ?? []) {
      if (person.id === undefined) continue;
      const ref: PitcherRef = {
        id: person.id,
        fullName: person.fullName ?? `Pitcher ${person.id}`,
        throws: person.pitchHand?.code ?? null,
      };
      this.cache.set(person.id, this.toSeason(ref, person.stats));
    }
  }

  private toSeason(
    pitcher: PitcherRef,
    stats: { splits?: { stat?: Record<string, unknown> }[] }[] | undefined,
  ): PitcherSeason | null {
    const stat = stats?.flatMap((group) => group.splits ?? []).find((split) => split.stat)?.stat;
    if (!stat) return null;

    const innings = parseInningsPitched(stat["inningsPitched"]) ?? 0;
    const gamesStarted = statNumber(stat["gamesStarted"]) ?? 0;
    const runs = statNumber(stat["runs"]);
    // Prefer total runs allowed; fall back to ERA scaled by the league's
    // historical earned-to-total ratio when only earned runs are available.
    const earned = statNumber(stat["earnedRuns"]);
    const runsForRate = runs ?? (earned === null ? null : earned * 1.07);

    return {
      pitcher,
      season: this.season,
      gamesStarted,
      inningsPitched: innings,
      era: statNumber(stat["era"]),
      whip: statNumber(stat["whip"]),
      strikeoutsPer9: per9(statNumber(stat["strikeOuts"]), innings > 0 ? innings : null),
      walksPer9: per9(statNumber(stat["baseOnBalls"]), innings > 0 ? innings : null),
      homeRunsPer9: per9(statNumber(stat["homeRuns"]), innings > 0 ? innings : null),
      runsAllowedPer9: per9(runsForRate, innings > 0 ? innings : null),
      inningsPerStart: gamesStarted > 0 && innings > 0 ? innings / gamesStarted : null,
    };
  }

  /** Season line for one pitcher; null when the API has no usable split. */
  async seasonStats(pitcher: PitcherRef): Promise<PitcherSeason | null> {
    if (!this.cache.has(pitcher.id)) await this.prefetch([pitcher]);
    return this.cache.get(pitcher.id) ?? null;
  }
}
