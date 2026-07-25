/** Stable content hashing for auditability and tamper detection. */
import { createHash } from "node:crypto";

/** Deterministic JSON stringify with sorted object keys. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(text).digest("hex");
}
