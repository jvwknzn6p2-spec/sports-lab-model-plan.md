// Phase 0 — Data Proof. Shared types for the probe.
//
// The probe answers ONE question per capability item: can we fetch this class
// of real data, for the reference case, from a real API — with the response
// bytes saved as evidence? Verdicts are derived exclusively from captured
// responses (never from provider documentation).

/** The four Phase 0 verdicts, exactly as specified in the project brief. */
export type Verdict = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "UNVERIFIED";

/** The 12 Phase 0 pass-condition items, in the brief's order. */
export const PHASE0_ITEMS = [
  "fixture",
  "historical_results",
  "teams",
  "players",
  "lineups",
  "formation",
  "injuries_suspensions",
  "match_statistics",
  "xg",
  "odds",
  "historical_odds",
  "final_result",
] as const;

export type Phase0Item = (typeof PHASE0_ITEMS)[number];

export const ITEM_LABELS: Record<Phase0Item, string> = {
  fixture: "Fixture",
  historical_results: "Historical results",
  teams: "Teams",
  players: "Players",
  lineups: "Lineups",
  formation: "Formation",
  injuries_suspensions: "Injuries / Suspensions",
  match_statistics: "Match statistics",
  xg: "xG",
  odds: "Odds",
  historical_odds: "Historical Odds",
  final_result: "Final Result",
};

/** Metadata recorded for every captured HTTP exchange (L0 lineage). */
export interface CaptureMeta {
  /** Provider slug, e.g. "sportmonks" | "the-odds-api". */
  provider: string;
  /** Stable name of the capture within the run (also the evidence filename). */
  name: string;
  /** Endpoint template with placeholders, e.g. "/v3/football/teams/search/{name}". */
  endpoint: string;
  /** Full request URL AFTER redaction — credentials must never appear here. */
  url: string;
  method: string;
  requestedAt: string; // ISO-8601 UTC, taken immediately before the request
  respondedAt: string; // ISO-8601 UTC, taken immediately after the response
  /** HTTP status code, or "ERR" when the request failed at transport level. */
  status: number | "ERR";
  /** Transport error message (redacted), only when status === "ERR". */
  error?: string;
  /** Byte length of the captured body. */
  bytes: number;
  /** sha256 hex of the captured body bytes. */
  sha256: string;
  /** Response headers worth keeping (rate limits etc.) — never auth headers. */
  headers?: Record<string, string>;
}

/** One captured exchange: metadata plus the raw body as text. */
export interface Capture {
  meta: CaptureMeta;
  body: string;
}

/** Verdict for one Phase 0 item, with its audit trail. */
export interface ItemVerdict {
  item: Phase0Item;
  verdict: Verdict;
  /** Human-readable reason, always grounded in the evidence (status, counts). */
  reason: string;
  /** Evidence filenames inside the run directory backing this verdict. */
  evidence: string[];
}

/** Summary of one probe run. */
export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Which credentials were present (never the values). */
  credentials: { sportmonks: boolean; theOddsApi: boolean };
  verdicts: ItemVerdict[];
}
