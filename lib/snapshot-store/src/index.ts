/**
 * `@workspace/snapshot-store` — timestamped JSON snapshots on disk.
 *
 * The plan requires every data pull to be cached and timestamped (§3) so that
 * re-runs are cheap and backtests can tell what was actually known at
 * prediction time. This is the smallest thing that satisfies both, and it needs
 * no database, so the record → analyse loop can start today.
 *
 * Snapshots are **versioned, not overwritten**. The morning pull and the
 * pre-game refresh are different observations of a moving target: starters get
 * announced, games get postponed, odds drift. Keeping both is what makes it
 * possible to measure that drift later — overwriting throws away the only copy
 * of what we believed this morning.
 *
 * ```
 * data/
 *   schedule/
 *     2026-07-25/
 *       2026-07-25T09-00-00-000Z.json   <- morning pull
 *       2026-07-25T21-30-00-000Z.json   <- pre-game refresh
 * ```
 *
 * The same store will hold odds snapshots (step 6) and predictions (step 10).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** A stored snapshot and where it came from. */
export interface Snapshot<T> {
  readonly kind: string;
  readonly date: string;
  /** ISO timestamp this snapshot was written. */
  readonly capturedAt: string;
  readonly path: string;
  readonly data: T;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Colons are not portable in filenames, so timestamps are stored with dashes. */
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;

function assertSafeSegment(value: string, label: string): void {
  if (value.length === 0 || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new RangeError(`${label} must be a simple path segment, got "${value}"`);
  }
}

function assertDate(date: string): void {
  if (!DATE_PATTERN.test(date)) {
    throw new RangeError(`date must be YYYY-MM-DD, got "${date}"`);
  }
}

/** `2026-07-25T09:00:00.000Z` → `2026-07-25T09-00-00-000Z`. */
export function timestampToFilename(iso: string): string {
  return `${iso.replace(/[:.]/g, "-")}.json`;
}

/** The inverse of {@link timestampToFilename}. Returns null for unrecognised names. */
export function filenameToTimestamp(filename: string): string | null {
  const match = FILE_PATTERN.exec(filename);
  if (!match) return null;
  const stamp = match[1];
  // Put the colons and the decimal point back: YYYY-MM-DDTHH-MM-SS-mmmZ
  const [datePart, timePart] = stamp.split("T");
  const [hour, minute, second, milli] = timePart.replace(/Z$/, "").split("-");
  return `${datePart}T${hour}:${minute}:${second}.${milli}Z`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await readdir(target);
    return true;
  } catch {
    return false;
  }
}

export class SnapshotStore {
  readonly root: string;

  /** @param root Directory to store snapshots under, e.g. `"data"`. */
  constructor(root: string) {
    this.root = root;
  }

  private directoryFor(kind: string, date: string): string {
    assertSafeSegment(kind, "kind");
    assertDate(date);
    return path.join(this.root, kind, date);
  }

  /**
   * Write a snapshot. Returns the path written.
   *
   * `capturedAt` defaults to now; pass it explicitly to keep a batch of writes
   * on one timestamp, or to replay historical data.
   */
  async write(kind: string, date: string, data: unknown, capturedAt?: string): Promise<string> {
    const stamp = capturedAt ?? new Date().toISOString();
    const directory = this.directoryFor(kind, date);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, timestampToFilename(stamp));
    // Pretty-printed: these files get read by humans during debugging, and they
    // diff far more usefully line by line.
    await writeFile(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return target;
  }

  /** Every snapshot timestamp for a date, oldest first. */
  async listVersions(kind: string, date: string): Promise<string[]> {
    const directory = this.directoryFor(kind, date);
    if (!(await pathExists(directory))) return [];
    const entries = await readdir(directory);
    return entries
      .map(filenameToTimestamp)
      .filter((stamp): stamp is string => stamp !== null)
      .sort();
  }

  /** Every date that has at least one snapshot of this kind, oldest first. */
  async listDates(kind: string): Promise<string[]> {
    assertSafeSegment(kind, "kind");
    const directory = path.join(this.root, kind);
    if (!(await pathExists(directory))) return [];
    const entries = await readdir(directory);
    return entries.filter((entry) => DATE_PATTERN.test(entry)).sort();
  }

  /** Read one specific version. */
  async read<T>(kind: string, date: string, capturedAt: string): Promise<Snapshot<T> | null> {
    const target = path.join(this.directoryFor(kind, date), timestampToFilename(capturedAt));
    try {
      const raw = await readFile(target, "utf8");
      return { kind, date, capturedAt, path: target, data: JSON.parse(raw) as T };
    } catch {
      return null;
    }
  }

  /**
   * Read the most recent snapshot for a date.
   *
   * This is what a same-day re-run should use — the freshest view. Backtests
   * should instead pick the version that existed at the time being simulated.
   */
  async readLatest<T>(kind: string, date: string): Promise<Snapshot<T> | null> {
    const versions = await this.listVersions(kind, date);
    const newest = versions.at(-1);
    if (!newest) return null;
    return this.read<T>(kind, date, newest);
  }

  /**
   * Read the snapshot that was current at a given moment.
   *
   * The guard against lookahead bias in backtesting: scoring this morning's
   * prediction against data that only arrived at first pitch would flatter the
   * model with information it did not have.
   */
  async readAsOf<T>(kind: string, date: string, asOf: string): Promise<Snapshot<T> | null> {
    const versions = await this.listVersions(kind, date);
    const eligible = versions.filter((version) => version <= asOf);
    const newest = eligible.at(-1);
    if (!newest) return null;
    return this.read<T>(kind, date, newest);
  }

  /** Read every version for a date, oldest first — for measuring drift over the day. */
  async readAll<T>(kind: string, date: string): Promise<Snapshot<T>[]> {
    const versions = await this.listVersions(kind, date);
    const snapshots: Snapshot<T>[] = [];
    for (const version of versions) {
      const snapshot = await this.read<T>(kind, date, version);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }
}
