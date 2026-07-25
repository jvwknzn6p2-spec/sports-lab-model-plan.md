/**
 * HTTP client for the MLB Stats API.
 *
 * The public endpoint needs no key and is generally reliable, but this runs
 * unattended every morning, so transient failures have to be handled rather
 * than crashing the day's run. Retries cover network errors, timeouts, 5xx and
 * 429; a 404 or a malformed date is a bug in our request and is surfaced
 * immediately instead of being retried four times first.
 *
 * `fetch` is injectable so the whole path — including retry behaviour — can be
 * tested without network access.
 */

export type MlbApiErrorKind = "network" | "timeout" | "http" | "invalid-response";

export class MlbApiError extends Error {
  readonly kind: MlbApiErrorKind;
  readonly url: string;
  readonly status: number | null;
  readonly attempts: number;

  constructor(
    kind: MlbApiErrorKind,
    message: string,
    details: { url: string; status?: number | null; attempts?: number; cause?: unknown },
  ) {
    super(message, { cause: details.cause });
    this.name = "MlbApiError";
    this.kind = kind;
    this.url = details.url;
    this.status = details.status ?? null;
    this.attempts = details.attempts ?? 1;
  }
}

export interface ClientOptions {
  /** Base URL, overridable for tests or a mirror. */
  readonly baseUrl?: string;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Attempts after the first. 3 retries means at most 4 requests. */
  readonly retries?: number;
  /** Base backoff in milliseconds; doubles each retry. */
  readonly backoffMs?: number;
  /** Injected for testing. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for testing, so retry tests do not actually wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Sent so MLB can identify the caller. */
  readonly userAgent?: string;
}

export const DEFAULT_BASE_URL = "https://statsapi.mlb.com/api/v1";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 429 and 5xx are worth retrying; other 4xx mean our request was wrong. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch and parse JSON, retrying transient failures with exponential backoff.
 *
 * Returns `unknown` — validation is the caller's job, so that a schema change
 * surfaces as a validation error naming the field rather than as a type lie.
 */
export async function requestJson(
  path: string,
  query: Record<string, string | number | undefined>,
  options: ClientOptions = {},
): Promise<unknown> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;

  const url = new URL(`${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const href = url.toString();

  let lastError: MlbApiError | null = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const response = await doFetch(href, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json",
          "user-agent": options.userAgent ?? "ai-sports-lab/0.1 (schedule fetch)",
        },
      });

      if (!response.ok) {
        const error = new MlbApiError("http", `MLB Stats API returned ${response.status}`, {
          url: href,
          status: response.status,
          attempts: attempt,
        });
        if (!isRetryableStatus(response.status)) throw error;
        lastError = error;
      } else {
        try {
          return await response.json();
        } catch (cause) {
          // A 200 with an unparseable body is not worth retrying — it means the
          // endpoint returned something that is not JSON at all.
          throw new MlbApiError("invalid-response", "MLB Stats API returned malformed JSON", {
            url: href,
            status: response.status,
            attempts: attempt,
            cause,
          });
        }
      }
    } catch (cause) {
      if (cause instanceof MlbApiError) {
        if (cause.kind === "http" && !isRetryableStatus(cause.status ?? 0)) throw cause;
        if (cause.kind === "invalid-response") throw cause;
        lastError = cause;
      } else {
        const timedOut =
          cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        lastError = new MlbApiError(
          timedOut ? "timeout" : "network",
          timedOut
            ? `MLB Stats API did not respond within ${timeoutMs}ms`
            : `Could not reach the MLB Stats API: ${cause instanceof Error ? cause.message : String(cause)}`,
          { url: href, attempts: attempt, cause },
        );
      }
    }

    if (attempt <= retries) {
      // Full jitter, so a scheduled job that fans out across many dates does
      // not retry every one of them in lockstep.
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await sleep(delay + Math.floor(Math.random() * backoffMs));
    }
  }

  throw (
    lastError ??
    new MlbApiError("network", "MLB Stats API request failed", { url: href, attempts: retries + 1 })
  );
}
