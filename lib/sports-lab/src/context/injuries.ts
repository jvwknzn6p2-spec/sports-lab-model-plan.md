/**
 * Step 3 — Injuries.
 *
 * Helpers over a team's normalized injury report. The validation layer uses
 * these to decide whether an injury materially changes team strength (a key
 * hitter or the listed starter ruled out) versus routine bench churn.
 */
import type { Injury, TeamInjuryReport } from "../schemas";

const MATERIAL_IMPACTS: ReadonlySet<Injury["impact"]> = new Set(["key-hitter", "starter"]);

/** Injuries that are ruled fully out (not day-to-day/probable). */
export function ruledOut(report: TeamInjuryReport): Injury[] {
  return report.injuries.filter((i) => i.status === "out");
}

/** Ruled-out injuries that materially change strength (key hitter / starter). */
export function materialAbsences(report: TeamInjuryReport): Injury[] {
  return report.injuries.filter((i) => i.status === "out" && MATERIAL_IMPACTS.has(i.impact));
}

/** True when at least one key hitter or the starter is ruled out. */
export function hasMaterialAbsence(report: TeamInjuryReport): boolean {
  return materialAbsences(report).length > 0;
}
