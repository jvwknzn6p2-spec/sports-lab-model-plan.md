/**
 * Daily on-disk cache for source pulls (plan Section 3: "cache daily pulls",
 * "timestamp everything"). Every entry records when it was fetched so re-runs
 * are fast and reproducible, and backtests can reconstruct exactly what the
 * model saw at prediction time.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CacheEntry<T> {
  /** ISO timestamp of when the underlying source was fetched. */
  fetchedAt: string;
  /** The request key (endpoint + params) this payload answers. */
  key: string;
  data: T;
}

export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

/** File-backed JSON cache namespaced by date, e.g. cache/2024-07-25/<key>.json. */
export class DailyCache {
  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private pathFor(date: string, key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(this.rootDir, date, `${safe}.json`);
  }

  async read<T>(date: string, key: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = await readFile(this.pathFor(date, key), "utf8");
      return JSON.parse(raw) as CacheEntry<T>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write<T>(date: string, key: string, data: T): Promise<CacheEntry<T>> {
    const entry: CacheEntry<T> = {
      fetchedAt: this.clock.now().toISOString(),
      key,
      data,
    };
    const path = this.pathFor(date, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry, null, 2), "utf8");
    return entry;
  }

  /** Read-through: return the cached payload or fetch, store, and return it. */
  async getOrFetch<T>(
    date: string,
    key: string,
    fetchFn: () => Promise<T>,
  ): Promise<CacheEntry<T>> {
    const existing = await this.read<T>(date, key);
    if (existing) return existing;
    const data = await fetchFn();
    return this.write(date, key, data);
  }
}
