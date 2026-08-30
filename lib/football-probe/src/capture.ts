import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Capture, CaptureMeta } from "./types";
import { assertNoSecrets, redactUrl, scrubSecrets } from "./redact";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** Response headers worth preserving as evidence (rate limits, entity tags). */
const KEPT_HEADERS = [
  "content-type",
  "x-ratelimit-remaining",
  "x-ratelimit-limit",
  "x-requests-remaining",
  "x-requests-used",
  "etag",
  "date",
];

/**
 * Append-only store for one probe run.
 *
 * probe/football/runs/<runId>/
 *   manifest.ndjson       one CaptureMeta per line, append-only
 *   <name>                the raw body bytes exactly as stored
 *
 * A run directory is created exactly once and never reused: constructing a
 * store over an existing directory throws. Raw snapshots are immutable —
 * saving the same name twice in a run throws.
 */
export class CaptureStore {
  readonly dir: string;
  private readonly secrets: readonly string[];
  private readonly saved = new Set<string>();

  constructor(rootDir: string, runId: string, secrets: readonly string[]) {
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`invalid runId: ${runId}`);
    this.dir = join(rootDir, runId);
    if (existsSync(this.dir)) {
      throw new Error(`run directory already exists (runs are immutable): ${this.dir}`);
    }
    mkdirSync(this.dir, { recursive: true });
    this.secrets = secrets;
  }

  /** Persist one captured exchange. Returns the stored capture (scrubbed). */
  save(meta: Omit<CaptureMeta, "bytes" | "sha256" | "url"> & { url: string }, body: string): Capture {
    if (!/^[A-Za-z0-9._-]+$/.test(meta.name)) throw new Error(`invalid capture name: ${meta.name}`);
    if (this.saved.has(meta.name)) {
      throw new Error(`capture already saved (snapshots are immutable): ${meta.name}`);
    }
    // Defense in depth: scrub first, then hard-assert nothing slipped through.
    const storedBody = scrubSecrets(body, this.secrets);
    const fullMeta: CaptureMeta = {
      ...meta,
      url: redactUrl(meta.url),
      error: meta.error === undefined ? undefined : scrubSecrets(meta.error, this.secrets),
      bytes: Buffer.byteLength(storedBody, "utf8"),
      sha256: sha256Hex(storedBody),
    };
    const metaLine = JSON.stringify(fullMeta);
    assertNoSecrets(storedBody, this.secrets, `body of ${meta.name}`);
    assertNoSecrets(metaLine, this.secrets, `meta of ${meta.name}`);

    writeFileSync(join(this.dir, meta.name), storedBody, { flag: "wx" });
    appendFileSync(join(this.dir, "manifest.ndjson"), metaLine + "\n");
    this.saved.add(meta.name);
    return { meta: fullMeta, body: storedBody };
  }
}

export interface FetchSpec {
  provider: string;
  name: string;
  /** Endpoint template (placeholders, no credentials) recorded as lineage. */
  endpoint: string;
  /** Full URL to request. Credentials in the query string get redacted before storage. */
  url: string;
  /** Extra request headers — the ONLY sanctioned place for credentials. */
  headers?: Record<string, string>;
}

/**
 * Perform one GET and persist it whatever happens: HTTP errors and transport
 * failures are evidence too. Never throws for network/HTTP reasons.
 */
export async function capturedFetch(store: CaptureStore, spec: FetchSpec): Promise<Capture> {
  const requestedAt = new Date().toISOString();
  try {
    const res = await fetch(spec.url, {
      headers: spec.headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    for (const h of KEPT_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return store.save(
      {
        provider: spec.provider,
        name: spec.name,
        endpoint: spec.endpoint,
        url: spec.url,
        method: "GET",
        requestedAt,
        respondedAt: new Date().toISOString(),
        status: res.status,
        headers,
      },
      body,
    );
  } catch (err) {
    return store.save(
      {
        provider: spec.provider,
        name: spec.name,
        endpoint: spec.endpoint,
        url: spec.url,
        method: "GET",
        requestedAt,
        respondedAt: new Date().toISOString(),
        status: "ERR",
        error: err instanceof Error ? err.message : String(err),
      },
      "",
    );
  }
}
