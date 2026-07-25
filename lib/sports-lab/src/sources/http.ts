/**
 * The single place the pipeline touches the network.
 *
 * Responsibilities, all of them things the plan asks for in Section 3:
 *   - Cache every pull on disk with a fetch timestamp ("timestamp everything",
 *     "cache daily pulls"), so re-runs are fast and reproducible.
 *   - Replay from fixtures in offline mode, where a *missing* fixture is an
 *     error rather than a silent empty response.
 *   - Retry transient failures with backoff, and stay polite with a minimum
 *     interval between calls to the same host.
 *   - Never write an API key to disk.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config";

export class FixtureMissingError extends Error {
  constructor(readonly cacheKey: string, readonly fixturePath: string) {
    super(
      `Offline mode: no fixture for "${cacheKey}". Expected ${fixturePath}. ` +
        `Record one by running online, or add a synthetic fixture.`,
    );
    this.name = "FixtureMissingError";
  }
}

export class HttpSourceError extends Error {
  constructor(
    readonly label: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "HttpSourceError";
  }
}

interface CacheEnvelope<T> {
  fetchedAt: string;
  /** URL with secrets stripped. */
  url: string;
  body: T;
}

export interface GetJsonOptions {
  /** Stable, filesystem-safe identity for this request. */
  cacheKey: string;
  /** Human label used in errors and logs. */
  label: string;
  /** Override the default cache TTL. 0 disables caching for this request. */
  ttlSeconds?: number;
  /** Query params appended to the URL. Values that are null are dropped. */
  query?: Record<string, string | number | null | undefined>;
  /** Param names whose values must never be persisted. */
  secretParams?: string[];
}

export interface FetchOutcome<T> {
  body: T;
  fetchedAt: string;
  /** Where the bytes came from — useful for the doctor command and reports. */
  origin: "network" | "cache" | "fixture";
}

/** Sanitise a cache key into a safe relative file path. */
export function cacheKeyToPath(cacheKey: string): string {
  const cleaned = cacheKey
    .split("/")
    .map((segment) =>
      segment
        .replace(/[^a-zA-Z0-9._=-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120),
    )
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (cleaned.length === 0) throw new Error(`Unusable cache key: "${cacheKey}"`);
  return `${cleaned.join("/")}.json`;
}

function buildUrl(
  base: string,
  query: GetJsonOptions["query"],
): { full: string; redacted: string } {
  const url = new URL(base);
  const redacted = new URL(base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
    redacted.searchParams.set(key, String(value));
  }
  return { full: url.toString(), redacted: redacted.toString() };
}

function redactUrl(url: string, secretParams: string[]): string {
  if (secretParams.length === 0) return url;
  const parsed = new URL(url);
  for (const name of secretParams) {
    if (parsed.searchParams.has(name)) parsed.searchParams.set(name, "REDACTED");
  }
  return parsed.toString();
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export class HttpClient {
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly config: RuntimeConfig) {}

  private cachePath(cacheKey: string): string {
    return path.join(this.config.dataDir, "cache", cacheKeyToPath(cacheKey));
  }

  private fixturePath(cacheKey: string): string {
    return path.join(this.config.fixtureDir, cacheKeyToPath(cacheKey));
  }

  private async readEnvelope<T>(file: string): Promise<CacheEnvelope<T> | null> {
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (parsed && typeof parsed === "object" && "body" in parsed) return parsed;
      // Bare-body fixtures are allowed for hand-written files.
      return { fetchedAt: new Date(0).toISOString(), url: file, body: parsed as T };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeEnvelope<T>(file: string, envelope: CacheEnvelope<T>): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  }

  private async throttle(host: string): Promise<void> {
    const interval = this.config.minRequestIntervalMs;
    if (interval <= 0) return;
    const last = this.lastRequestAt.get(host);
    const now = Date.now();
    if (last !== undefined) {
      const wait = interval - (now - last);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt.set(host, Date.now());
  }

  async getJson<T>(base: string, options: GetJsonOptions): Promise<FetchOutcome<T>> {
    const secretParams = options.secretParams ?? [];
    const { full } = buildUrl(base, options.query);
    const storedUrl = redactUrl(full, secretParams);

    if (this.config.offline) {
      const file = this.fixturePath(options.cacheKey);
      const envelope = await this.readEnvelope<T>(file);
      if (!envelope) throw new FixtureMissingError(options.cacheKey, file);
      return { body: envelope.body, fetchedAt: envelope.fetchedAt, origin: "fixture" };
    }

    const ttl = options.ttlSeconds ?? this.config.cacheTtlSeconds;
    const cacheFile = this.cachePath(options.cacheKey);
    if (ttl > 0) {
      const cached = await this.readEnvelope<T>(cacheFile);
      if (cached) {
        const ageSeconds = (Date.now() - Date.parse(cached.fetchedAt)) / 1000;
        if (Number.isFinite(ageSeconds) && ageSeconds >= 0 && ageSeconds < ttl) {
          return { body: cached.body, fetchedAt: cached.fetchedAt, origin: "cache" };
        }
      }
    }

    const host = new URL(full).host;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(16000, 500 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
      await this.throttle(host);
      try {
        const response = await fetch(full, {
          headers: { accept: "application/json", "user-agent": "ai-sports-lab/1.0" },
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 300);
          const error = new HttpSourceError(
            options.label,
            response.status,
            `${options.label}: HTTP ${response.status} from ${redactUrl(full, secretParams)}${
              detail ? ` — ${detail}` : ""
            }`,
          );
          if (RETRYABLE_STATUS.has(response.status) && attempt < this.config.maxRetries) {
            lastError = error;
            continue;
          }
          throw error;
        }
        const body = (await response.json()) as T;
        const fetchedAt = new Date().toISOString();
        if (ttl > 0) {
          await this.writeEnvelope(cacheFile, { fetchedAt, url: storedUrl, body });
        }
        return { body, fetchedAt, origin: "network" };
      } catch (error) {
        if (error instanceof HttpSourceError) throw error;
        lastError =
          error instanceof Error ? error : new Error(`${options.label}: ${String(error)}`);
        if (attempt >= this.config.maxRetries) break;
      }
    }

    // Serve a stale cache entry rather than losing the whole day's slate, but
    // say so — the caller turns this into a `stale_data` issue.
    const stale = await this.readEnvelope<T>(cacheFile);
    if (stale) {
      return { body: stale.body, fetchedAt: stale.fetchedAt, origin: "cache" };
    }
    throw new HttpSourceError(
      options.label,
      null,
      `${options.label}: all ${this.config.maxRetries + 1} attempts failed — ${
        lastError?.message ?? "unknown error"
      }`,
    );
  }
}
