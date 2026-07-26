/**
 * Steps 1–2 — MLB Stats API HTTP client.
 *
 * A thin, injectable client. `fetch` is a constructor parameter rather than a
 * global so the whole ingest layer is testable against recorded fixtures with
 * no network — which is also what lets the daily pipeline be exercised in CI.
 *
 * The API is public and unauthenticated, but it is someone else's free
 * service: requests are serialized with a small delay by default rather than
 * fanned out, because a slate of 15 games otherwise means a burst of ~60
 * requests in a few milliseconds.
 */
import { z } from "zod";

/** Minimal structural type satisfied by `globalThis.fetch`. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";

/** Thrown for transport failures, non-2xx responses, and unparseable bodies. */
export class MlbApiError extends Error {
  readonly path: string;
  readonly status: number | null;
  constructor(path: string, status: number | null, message: string) {
    super(`MLB Stats API ${path}: ${message}`);
    this.name = "MlbApiError";
    this.path = path;
    this.status = status;
  }
}

export interface MlbClientOptions {
  /** Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Defaults to the public v1 base URL. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Retries for transport errors and 5xx. Defaults to 2. */
  maxRetries?: number;
  /** Minimum gap between requests in ms. Defaults to 60. */
  minIntervalMs?: number;
  /** Sleep hook, so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class MlbClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes requests so a slate does not burst against a free API. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: MlbClientOptions = {}) {
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    if (options.fetch === undefined && globalFetch === undefined) {
      throw new TypeError("No fetch implementation available; pass one via options.fetch");
    }
    this.fetchImpl = options.fetch ?? (globalFetch as FetchLike);
    this.baseUrl = options.baseUrl ?? MLB_API_BASE;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.minIntervalMs = options.minIntervalMs ?? 60;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Build a full URL, dropping params whose value is null/undefined. */
  private url(path: string, params: Record<string, string | number | undefined | null>): string {
    const search = Object.entries(params)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return `${this.baseUrl}${path}${search === "" ? "" : `?${search}`}`;
  }

  /**
   * GET a path and validate the body against `schema`.
   *
   * Retries transport errors and 5xx with linear backoff; a 4xx is a bad
   * request on our side and is not retried.
   */
  async get<S extends z.ZodTypeAny>(
    path: string,
    params: Record<string, string | number | undefined | null>,
    schema: S,
  ): Promise<z.output<S>> {
    const run = async (): Promise<z.output<S>> => {
      const url = this.url(path, params);
      let lastError: MlbApiError | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) await this.sleep(this.minIntervalMs * attempt * 4);
        else await this.sleep(this.minIntervalMs);

        let body: string;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);
          let response;
          try {
            response = await this.fetchImpl(url, {
              signal: controller.signal,
              headers: { accept: "application/json" },
            });
          } finally {
            clearTimeout(timer);
          }

          if (!response.ok) {
            const error = new MlbApiError(path, response.status, `HTTP ${response.status}`);
            // 4xx means we asked wrongly — retrying will not help.
            if (response.status < 500) throw error;
            lastError = error;
            continue;
          }
          body = await response.text();
        } catch (error) {
          if (error instanceof MlbApiError) throw error;
          lastError = new MlbApiError(path, null, error instanceof Error ? error.message : String(error));
          continue;
        }

        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          throw new MlbApiError(path, null, "response was not valid JSON");
        }

        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          // Shape drift is a hard failure, not a silent null: the upstream
          // contract changed and every downstream number would be suspect.
          throw new MlbApiError(path, null, `unexpected response shape: ${parsed.error.message}`);
        }
        return parsed.data;
      }

      throw lastError ?? new MlbApiError(path, null, "request failed");
    };

    // Chain onto the queue so requests go out one at a time.
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
