import type { Capture, ItemVerdict, Phase0Item, Verdict } from "./types";

// Verdicts are decided ONLY from captured responses. The mapping is fixed and
// documented in football/docs/phase0-data-proof.md:
//
//   2xx + item data present   -> AVAILABLE
//   2xx + no item data        -> PARTIAL     (endpoint answers, reference case empty/incomplete)
//   402 / 403 / 404           -> UNAVAILABLE (denied or absent on the current plan)
//   401                       -> UNVERIFIED  (credential rejected — proves nothing about the data)
//   transport failure / other -> UNVERIFIED
//   no capture at all         -> UNVERIFIED  (not attempted, e.g. no credential configured)

/** How much data the capture's body carries for the item; null = unparseable. */
export type Extractor = (body: unknown) => number | null;

export interface ClassifiedEvidence {
  capture: Capture;
  verdict: Verdict;
  detail: string;
}

export function classifyCapture(capture: Capture, extract: Extractor): ClassifiedEvidence {
  const { status } = capture.meta;
  if (status === "ERR") {
    return { capture, verdict: "UNVERIFIED", detail: `transport failure: ${capture.meta.error ?? "unknown"}` };
  }
  if (status === 401) {
    // Some providers answer plan-level denials with 401 instead of 402/403
    // (measured 2026-08-30: The Odds API historical endpoint returns 401 with
    // error_code HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN on a valid free
    // key). When the body itself names an *_UNAVAILABLE_* error code, that is
    // a real answer about the current plan, not an unverifiable auth failure.
    const code = errorCode(capture.body);
    if (code !== undefined && code.includes("UNAVAILABLE")) {
      return { capture, verdict: "UNAVAILABLE", detail: `HTTP 401 — ${code} (denied on current plan)` };
    }
    return { capture, verdict: "UNVERIFIED", detail: "HTTP 401 — credential rejected" };
  }
  if (status === 402 || status === 403 || status === 404) {
    return { capture, verdict: "UNAVAILABLE", detail: `HTTP ${status} — denied/absent on current plan` };
  }
  if (status < 200 || status >= 300) {
    return { capture, verdict: "UNVERIFIED", detail: `HTTP ${status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture.body);
  } catch {
    return { capture, verdict: "UNVERIFIED", detail: `HTTP ${status} but body is not JSON` };
  }
  const count = extract(parsed);
  if (count === null) {
    return { capture, verdict: "PARTIAL", detail: `HTTP ${status} but expected shape not found` };
  }
  if (count > 0) {
    return { capture, verdict: "AVAILABLE", detail: `HTTP ${status}, ${count} record(s)` };
  }
  return { capture, verdict: "PARTIAL", detail: `HTTP ${status}, 0 records for reference case` };
}

function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>)["error_code"];
      if (typeof code === "string") return code;
    }
  } catch {
    // not JSON — fall through
  }
  return undefined;
}

const RANK: Record<Verdict, number> = { AVAILABLE: 3, PARTIAL: 2, UNAVAILABLE: 1, UNVERIFIED: 0 };

/**
 * Combine evidence for one item. The strongest verdict wins (a capability is
 * available if ANY real provider delivered it), but every piece of evidence
 * stays in the trail.
 */
export function combineEvidence(item: Phase0Item, evidence: ClassifiedEvidence[], noEvidenceReason: string): ItemVerdict {
  if (evidence.length === 0) {
    return { item, verdict: "UNVERIFIED", reason: noEvidenceReason, evidence: [] };
  }
  const best = evidence.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  const reason = evidence
    .map((e) => `${e.capture.meta.provider}: ${e.verdict} (${e.detail})`)
    .join("; ");
  return { item, verdict: best.verdict, reason, evidence: evidence.map((e) => e.capture.meta.name) };
}
