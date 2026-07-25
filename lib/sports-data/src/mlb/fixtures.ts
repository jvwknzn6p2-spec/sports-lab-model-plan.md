/**
 * Offline transport for the MLB client.
 *
 * `statsapi.mlb.com` is frequently unreachable from restricted/CI environments
 * (egress policy). A fixture fetcher lets the exact same client + parser code
 * run against recorded payloads, so Step 2 is fully exercisable and testable
 * without network access.
 */

import type { Fetcher } from "./client";

export interface FixtureRoute {
  /** Substring or RegExp matched against the request URL. */
  readonly match: string | RegExp;
  readonly payload: unknown;
  readonly status?: number;
}

/**
 * Build a Fetcher that resolves each URL to the first matching route's payload.
 * An unmatched URL resolves to a 404 (so callers exercise the fail-loud path)
 * unless `strict` is set, in which case it throws — useful in tests to catch an
 * unexpected request.
 */
export function fixtureFetcher(
  routes: FixtureRoute[],
  opts: { strict?: boolean } = {},
): Fetcher {
  return async (url: string) => {
    const route = routes.find((r) =>
      typeof r.match === "string" ? url.includes(r.match) : r.match.test(url),
    );
    if (!route) {
      if (opts.strict) {
        throw new Error(`No fixture route matched URL: ${url}`);
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ message: "no fixture", url }),
      };
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.payload,
    };
  };
}
