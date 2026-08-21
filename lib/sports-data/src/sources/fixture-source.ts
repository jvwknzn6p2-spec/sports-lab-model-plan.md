/**
 * Offline CoreDataSource backed by an in-memory fixture bundle.
 *
 * Lets the full Step-2 pipeline run without network access (the MLB API is
 * often blocked by egress policy in CI/sandboxes). The bundle is plain JSON, so
 * it doubles as recorded test data and as a reproducible demo slate.
 */

import type { BullpenWorkload } from "../features";
import type { NormalizedGame } from "../mlb/parse";
import type { RawBattingLine, RawPitchingLine } from "../sabermetrics";
import type { CoreDataSource, TeamRecentForm } from "../step2";
import type { GameWeather } from "./weather";
import type { IlPlayer } from "./injuries-builder";
import type { GameLineups } from "../features/lineup";

export interface FixtureBundle {
  date: string;
  season: number;
  /** When the slate was generated (set by fetch-slate; absent on hand-made fixtures). */
  fetchedAt?: string;
  games: NormalizedGame[];
  /** Keyed by stringified pitcherId. */
  starters: Record<string, RawPitchingLine>;
  /** Keyed by stringified teamId. */
  batting: Record<string, RawBattingLine>;
  /** Keyed by stringified teamId. */
  bullpens: Record<string, RawPitchingLine>;
  /** Keyed by stringified teamId (optional). */
  workloads?: Record<string, BullpenWorkload>;
  /** Keyed by stringified venueId (optional). */
  parkFactors?: Record<string, number>;
  /** Keyed by stringified teamId (optional): last-N-games scoring. */
  forms?: Record<string, TeamRecentForm>;
  /** Keyed by stringified gamePk (optional): first-pitch weather. */
  weather?: Record<string, GameWeather>;
  /** Keyed by stringified teamId (optional): players on the IL. */
  injuries?: Record<string, IlPlayer[]>;
  /** Keyed by stringified gamePk (optional): posted batting orders. */
  lineups?: Record<string, GameLineups>;
  /** Keyed by stringified playerId (optional): lineup bats' season lines. */
  lineupBatting?: Record<string, RawBattingLine>;
}

export class FixtureCoreDataSource implements CoreDataSource {
  constructor(private readonly bundle: FixtureBundle) {}

  async getSchedule(date: string): Promise<NormalizedGame[]> {
    if (date !== this.bundle.date) return [];
    return this.bundle.games;
  }

  async getStarterLine(pitcherId: number): Promise<RawPitchingLine | null> {
    return this.bundle.starters[String(pitcherId)] ?? null;
  }

  async getTeamBattingLine(teamId: number): Promise<RawBattingLine | null> {
    return this.bundle.batting[String(teamId)] ?? null;
  }

  async getBullpenLine(teamId: number): Promise<RawPitchingLine | null> {
    return this.bundle.bullpens[String(teamId)] ?? null;
  }

  async getBullpenWorkload(
    teamId: number,
  ): Promise<BullpenWorkload | undefined> {
    return this.bundle.workloads?.[String(teamId)];
  }

  async getParkFactor(venueId: number | null): Promise<number | undefined> {
    if (venueId === null) return undefined;
    return this.bundle.parkFactors?.[String(venueId)];
  }

  async getRecentForm(teamId: number): Promise<TeamRecentForm | undefined> {
    return this.bundle.forms?.[String(teamId)];
  }

  async getWeather(gamePk: number): Promise<GameWeather | undefined> {
    return this.bundle.weather?.[String(gamePk)];
  }

  async getInjuries(teamId: number): Promise<IlPlayer[] | undefined> {
    return this.bundle.injuries?.[String(teamId)];
  }

  async getLineup(gamePk: number): Promise<GameLineups | undefined> {
    return this.bundle.lineups?.[String(gamePk)];
  }

  async getPlayerBattingLine(playerId: number): Promise<RawBattingLine | null> {
    return this.bundle.lineupBatting?.[String(playerId)] ?? null;
  }
}
