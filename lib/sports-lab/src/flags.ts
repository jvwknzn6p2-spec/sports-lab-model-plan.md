/**
 * Step 3 — Flag registry and confidence-rank utilities.
 *
 * The validation layer emits typed flags rather than free-text strings so
 * downstream stages (confidence ranking, AI review, the daily report) can act
 * on them programmatically. Severity drives the confidence cap:
 *   - error → data is unusable or misleading; cap hard.
 *   - warn  → usable but degraded; cap moderately.
 *   - info  → worth surfacing, no cap.
 */
import type { ConfidenceRank } from "./schemas";

export type FlagSeverity = "info" | "warn" | "error";

/** Stable machine codes for every condition the validation layer detects. */
export type FlagCode =
  | "missing_starter" // no starter named for a side
  | "unconfirmed_starter" // starter named but not officially confirmed
  | "weather_forecast" // weather is a forecast, not an observed reading
  | "weather_forecast_stale" // forecast targets a time far from first pitch
  | "weather_missing" // no usable weather at all (and roof does not cover it)
  | "weather_precip_risk" // meaningful precipitation chance
  | "park_factors_fallback" // venue not in park-factor table; neutral used
  | "injury_key_player_out" // a key hitter / starter is ruled out
  | "lineup_unconfirmed" // official lineup not yet posted
  | "recent_form_small_sample" // fewer completed games than desired
  | "recent_form_missing" // no recent-form data for a side
  | "missing_batting" // no team batting stats — offense cannot be modeled
  | "missing_bullpen" // no bullpen stats for a side
  | "bullpen_fatigue" // bullpen threw heavy innings in the last 3 days
  | "stale_data"; // a source was fetched too long ago

export interface Flag {
  code: FlagCode;
  severity: FlagSeverity;
  /** Dotted path of the affected data, e.g. "weather", "injuries.home". */
  field: string;
  /** Human-readable, report-ready explanation. */
  message: string;
}

/** Confidence ranks best → worst. Index = strength (0 is strongest). */
export const CONFIDENCE_ORDER: readonly ConfidenceRank[] = ["S", "A", "B", "C"] as const;

/** Return the weaker (lower) of two ranks. */
export function minRank(a: ConfidenceRank, b: ConfidenceRank): ConfidenceRank {
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

/** Drop a rank by `steps`, clamped at the worst rank ("C"). */
export function lowerRank(rank: ConfidenceRank, steps: number): ConfidenceRank {
  const idx = Math.min(CONFIDENCE_ORDER.indexOf(rank) + Math.max(0, steps), CONFIDENCE_ORDER.length - 1);
  return CONFIDENCE_ORDER[idx];
}

/** Highest severity present in a flag set, or null when empty. */
export function maxSeverity(flags: readonly Flag[]): FlagSeverity | null {
  if (flags.some((f) => f.severity === "error")) return "error";
  if (flags.some((f) => f.severity === "warn")) return "warn";
  if (flags.some((f) => f.severity === "info")) return "info";
  return null;
}
