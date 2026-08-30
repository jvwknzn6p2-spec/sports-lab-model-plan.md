// Extractors turn a parsed response body into "how many records of the item
// did this capture actually carry?" — null when the expected shape is absent.
// They are deliberately tolerant of wrappers but never invent data.

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Sportmonks v3 wraps payloads as { data: [...] } or { data: {...} }. */
export function sportmonksData(body: unknown): unknown {
  const rec = asRecord(body);
  return rec ? rec["data"] : undefined;
}

/** Count of entries in a Sportmonks list response. */
export function smListCount(body: unknown): number | null {
  const data = sportmonksData(body);
  if (Array.isArray(data)) return data.length;
  if (asRecord(data)) return 1;
  return null;
}

/**
 * Count of non-empty include payloads under Sportmonks fixture data.
 * Accepts any of the candidate keys (include naming varies in case).
 */
export function smIncludeCount(keys: string[]): (body: unknown) => number | null {
  return (body: unknown) => {
    const data = sportmonksData(body);
    const items = Array.isArray(data) ? data : asRecord(data) ? [data] : null;
    if (items === null) return null;
    let found = false;
    let count = 0;
    for (const it of items) {
      const rec = asRecord(it);
      if (!rec) continue;
      for (const key of keys) {
        if (!(key in rec)) continue;
        found = true;
        const v = rec[key];
        if (Array.isArray(v)) count += v.length;
        else if (v !== null && v !== undefined) count += 1;
      }
    }
    return found ? count : null;
  };
}

/** Count of Sportmonks fixtures that carry a final/current score. */
export function smScoredFixtureCount(body: unknown): number | null {
  const data = sportmonksData(body);
  if (!Array.isArray(data)) return null;
  let n = 0;
  for (const it of data) {
    const rec = asRecord(it);
    const scores = rec?.["scores"];
    if (Array.isArray(scores) && scores.length > 0) n += 1;
  }
  return n;
}

/** The Odds API: top-level JSON array responses (sports list, odds list). */
export function oddsApiArrayCount(body: unknown): number | null {
  return Array.isArray(body) ? body.length : null;
}

/** The Odds API sports catalog: is a given sport key listed and active? */
export function oddsApiSportListed(sportKey: string): (body: unknown) => number | null {
  return (body: unknown) => {
    if (!Array.isArray(body)) return null;
    return body.filter((s) => asRecord(s)?.["key"] === sportKey).length;
  };
}

/** The Odds API historical endpoint wraps the odds list as { data: [...] }. */
export function oddsApiHistoricalCount(body: unknown): number | null {
  const rec = asRecord(body);
  const data = rec?.["data"];
  if (Array.isArray(data)) return data.length;
  return null;
}
