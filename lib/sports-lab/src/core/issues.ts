/**
 * The "fail loudly" channel.
 *
 * Sources never substitute a plausible number for a missing one. They record a
 * DataIssue and leave the field null. `pipeline/validate.ts` turns the issue
 * list into a data-quality score, and `pipeline/confidence.ts` uses that score
 * to cap the confidence rank. A game with missing inputs can still get a
 * prediction — it just cannot get a high rank.
 */

import type { DataIssue, IssueSeverity } from "./types";

export class IssueCollector {
  private readonly issues: DataIssue[] = [];

  add(severity: IssueSeverity, code: string, field: string, message: string): void {
    this.issues.push({ code, severity, field, message });
  }

  info(code: string, field: string, message: string): void {
    this.add("info", code, field, message);
  }

  warn(code: string, field: string, message: string): void {
    this.add("warn", code, field, message);
  }

  error(code: string, field: string, message: string): void {
    this.add("error", code, field, message);
  }

  /** Merge issues from a nested collector, prefixing their field paths. */
  absorb(prefix: string, other: DataIssue[]): void {
    for (const issue of other) {
      this.issues.push({
        ...issue,
        field: prefix ? `${prefix}.${issue.field}` : issue.field,
      });
    }
  }

  list(): DataIssue[] {
    return [...this.issues];
  }

  has(severity: IssueSeverity): boolean {
    return this.issues.some((i) => i.severity === severity);
  }

  count(severity: IssueSeverity): number {
    return this.issues.filter((i) => i.severity === severity).length;
  }
}

export const ISSUE_CODES = {
  starterUnconfirmed: "starter_unconfirmed",
  starterStatsMissing: "starter_stats_missing",
  offenseMissing: "team_offense_missing",
  bullpenMissing: "bullpen_missing",
  formMissing: "recent_form_missing",
  injuriesMissing: "injuries_missing",
  weatherMissing: "weather_missing",
  venueGeoMissing: "venue_geo_missing",
  parkFactorUnknown: "park_factor_unknown",
  oddsMissing: "odds_missing",
  oddsKeyMissing: "odds_api_key_missing",
  oddsMarketMissing: "odds_market_missing",
  smallSample: "small_sample",
  sourceError: "source_error",
  staleData: "stale_data",
  calibrationDefault: "calibration_default",
} as const;
