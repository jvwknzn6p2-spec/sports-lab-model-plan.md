/**
 * Step 3's output: turn the issue list into a data-quality score.
 *
 * Weights reflect how much each input actually moves a prediction. A missing
 * starting pitcher is worth far more than a missing injury list, and the score
 * should say so — it is what caps the confidence rank downstream.
 */

import type { DataQuality, GameContext, Side } from "../core/types";

interface Requirement {
  field: string;
  weight: number;
  /** True when the input is present and usable. */
  present: (ctx: GameContext) => boolean;
  /** When false, the game cannot be predicted at all. */
  critical?: boolean;
}

const SIDES: Side[] = ["home", "away"];

const REQUIREMENTS: Requirement[] = [
  ...SIDES.map((side) => ({
    field: `${side}.offense`,
    weight: 3,
    critical: true,
    present: (ctx: GameContext) => ctx.teams[side].offense?.runsPerGame != null,
  })),
  ...SIDES.map((side) => ({
    field: `${side}.starter`,
    weight: 3,
    present: (ctx: GameContext) => ctx.teams[side].starter?.runsAllowedPer9 != null,
  })),
  ...SIDES.map((side) => ({
    field: `${side}.bullpen`,
    weight: 1.5,
    present: (ctx: GameContext) => ctx.teams[side].bullpen?.runsAllowedPer9 != null,
  })),
  ...SIDES.map((side) => ({
    field: `${side}.form`,
    weight: 0.5,
    present: (ctx: GameContext) => ctx.teams[side].form?.runsScoredPerGame != null,
  })),
  ...SIDES.map((side) => ({
    field: `${side}.injuries`,
    weight: 0.5,
    present: (ctx: GameContext) => ctx.teams[side].injuries != null,
  })),
  {
    field: "weather",
    weight: 1,
    present: (ctx) =>
      ctx.weather !== null && (ctx.weather.roofClosed || ctx.weather.temperatureF !== null),
  },
  { field: "park", weight: 1, present: (ctx) => ctx.park.matched },
  { field: "odds.moneyline", weight: 1.5, present: (ctx) => ctx.odds?.moneyline != null },
  { field: "odds.total", weight: 0.5, present: (ctx) => ctx.odds?.total != null },
];

export function assessDataQuality(context: GameContext): DataQuality {
  let totalWeight = 0;
  let presentWeight = 0;
  const missing: string[] = [];
  let usable = true;

  for (const requirement of REQUIREMENTS) {
    totalWeight += requirement.weight;
    if (requirement.present(context)) {
      presentWeight += requirement.weight;
    } else {
      missing.push(requirement.field);
      if (requirement.critical) usable = false;
    }
  }

  return {
    completeness: totalWeight > 0 ? presentWeight / totalWeight : 0,
    missing,
    errorCount: context.issues.filter((i) => i.severity === "error").length,
    warnCount: context.issues.filter((i) => i.severity === "warn").length,
    usable,
  };
}
