/**
 * Adapter factory — config decides the source, business logic never does.
 *
 * `HANDIEDGE_SOURCE=fixture` (default) or `http`. For http, set
 * `HANDIEDGE_API_BASE_URL` (and optionally `HANDIEDGE_API_KEY`).
 */
import { FixtureSource } from "./fixture.js";
import { HttpSource } from "./http.js";
import type { IntakeSource } from "./types.js";

export type { IntakeSource } from "./types.js";
export { FixtureSource } from "./fixture.js";
export { HttpSource } from "./http.js";

export function sourceFromEnv(env: NodeJS.ProcessEnv = process.env): IntakeSource {
  const kind = (env.HANDIEDGE_SOURCE ?? "fixture").toLowerCase();
  if (kind === "http") {
    const baseUrl = env.HANDIEDGE_API_BASE_URL;
    if (!baseUrl) {
      throw new Error("HANDIEDGE_SOURCE=http requires HANDIEDGE_API_BASE_URL");
    }
    const headers = env.HANDIEDGE_API_KEY
      ? { authorization: `Bearer ${env.HANDIEDGE_API_KEY}` }
      : undefined;
    return new HttpSource({ baseUrl, headers });
  }
  if (kind !== "fixture") {
    throw new Error(`unknown HANDIEDGE_SOURCE: ${kind} (expected 'fixture' or 'http')`);
  }
  return new FixtureSource();
}
