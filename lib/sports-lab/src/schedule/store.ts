import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DailySchedule } from "./types";

/**
 * On-disk cache for daily schedule pulls.
 *
 * Implements two data principles from the plan:
 *  - "Cache daily pulls": each slate is stored once and re-reads are free.
 *  - "Timestamp everything": the stored {@link DailySchedule} carries
 *    `fetchedAtUtc`, and the raw upstream payload is kept alongside it so a
 *    pull can be replayed/audited during backtesting.
 *
 * Layout under `rootDir`:
 *   schedule/<date>.json       parsed DailySchedule (source of truth)
 *   schedule/<date>.raw.json   untouched upstream payload (optional)
 *
 * Writes are idempotent per date: re-running a day overwrites that day's files
 * rather than appending, so the cache always reflects the latest good pull.
 */
export class DailyScheduleStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** Absolute path of the parsed schedule file for a date. */
  pathFor(date: string): string {
    return join(this.rootDir, "schedule", `${date}.json`);
  }

  /** Absolute path of the raw upstream payload for a date. */
  rawPathFor(date: string): string {
    return join(this.rootDir, "schedule", `${date}.raw.json`);
  }

  /** Whether a parsed schedule is already cached for a date. */
  has(date: string): boolean {
    return existsSync(this.pathFor(date));
  }

  /**
   * Persist a parsed schedule (and optionally its raw payload). Returns the
   * path of the parsed file. Validates before writing so we never cache a
   * malformed object.
   */
  async save(schedule: DailySchedule, raw?: unknown): Promise<string> {
    const validated = DailySchedule.parse(schedule);
    const path = this.pathFor(validated.date);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");

    if (raw !== undefined) {
      const rawPath = this.rawPathFor(validated.date);
      await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    }
    return path;
  }

  /**
   * Load a cached schedule for a date, or `null` if none is cached. Validates
   * on read so a corrupted cache file fails loudly rather than flowing bad data
   * downstream.
   */
  async load(date: string): Promise<DailySchedule | null> {
    const path = this.pathFor(date);
    if (!existsSync(path)) {
      return null;
    }
    const contents = await readFile(path, "utf8");
    return DailySchedule.parse(JSON.parse(contents));
  }
}
