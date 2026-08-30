// Secrets must never reach a file that gets committed, or a log line.
// Two layers: (1) strip credential-shaped query params from URLs before they
// are recorded, (2) a hard assert that scans everything about to be persisted
// for the literal secret values and throws if any is found. Layer 2 is the
// one that actually guarantees the invariant; layer 1 keeps recorded URLs
// useful even when a provider only accepts query-param auth.

const CREDENTIAL_PARAMS = ["api_token", "apikey", "apiKey", "api_key", "token", "key"];

/** Replace credential-shaped query parameter values with a placeholder. */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "<unparseable-url>";
  }
  for (const p of CREDENTIAL_PARAMS) {
    if (u.searchParams.has(p)) u.searchParams.set(p, "<redacted>");
  }
  return u.toString();
}

/** Remove every occurrence of the given secret values from a text. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join("<redacted>");
  }
  return out;
}

export class SecretLeakError extends Error {
  constructor(context: string) {
    // Deliberately does NOT include the offending content.
    super(`secret value would have been persisted (${context}); refusing to write`);
    this.name = "SecretLeakError";
  }
}

/**
 * Throw if any secret value appears in the text. Called on every payload and
 * every metadata line immediately before it is written to disk — this is the
 * fail-closed layer.
 */
export function assertNoSecrets(text: string, secrets: readonly string[], context: string): void {
  for (const s of secrets) {
    if (s.length > 0 && text.includes(s)) throw new SecretLeakError(context);
  }
}
