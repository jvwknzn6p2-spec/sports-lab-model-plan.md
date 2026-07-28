/**
 * Starting-pitcher feature builder — FIP-forward.
 *
 * We project a starter's run prevention from FIP/xFIP, NOT ERA, then regress to
 * the league mean by sample size and convert to an expected total-run rate the
 * baseline model can consume. Steps, all explainable:
 *
 *   1. Compute the DIPS estimators (FIP, xFIP, kwERA).
 *   2. Blend FIP and xFIP into one defense-independent talent estimate
 *      (xFIP is more stable in-season because it neutralizes HR/FB noise).
 *   3. Regress that estimate toward league FIP with an innings-based prior
 *      (small samples get pulled toward average — no 40-IP mirage aces).
 *   4. Apply the park factor.
 *   5. Convert earned-run scale (FIP) to a total-run rate for the run model.
 */

import {
  computePitchingMetrics,
  getLeagueConstants,
  inningsToDecimal,
  type PitchingMetrics,
  type RawPitchingLine,
} from "../sabermetrics";
import {
  RUNS_PER_EARNED_RUN,
  regressToMean,
  reliabilityWeight,
  type DataQualityFlag,
} from "./types";

/** Innings-of-prior used to regress a starter's FIP toward league average. */
export const STARTER_FIP_PRIOR_IP = 55;
/** Below this IP the sample is flagged as thin. */
const LOW_SAMPLE_IP = 40;

export interface StartingPitcherInput {
  pitcherId?: number;
  pitcherName?: string;
  season: number;
  line: RawPitchingLine;
  /** One-year park factor for the start's venue (100 = neutral). */
  parkFactor?: number;
  /** xFIP weight in the FIP/xFIP blend (default 0.5). */
  xfipWeight?: number;
}

export interface StartingPitcherFeatures {
  pitcherId: number | null;
  pitcherName: string | null;
  metrics: PitchingMetrics;
  /** FIP/xFIP blend regressed to league mean and park-adjusted. */
  projectedFip: number;
  /** Expected TOTAL runs allowed per 9 innings (feeds the run model). */
  expectedRunsAllowedPer9: number;
  /** 0–1 confidence based on innings sample. */
  reliability: number;
  flags: DataQualityFlag[];
}

export function buildStartingPitcherFeatures(
  input: StartingPitcherInput,
): StartingPitcherFeatures {
  const { line, season } = input;
  const c = getLeagueConstants(season);
  const metrics = computePitchingMetrics(line, season);
  const ip = inningsToDecimal(line.inningsPitched);
  const flags: DataQualityFlag[] = [];

  // 1–2. Blend FIP and xFIP into a defense-independent talent estimate.
  const xfipWeight = input.xfipWeight ?? 0.5;
  let dips: number;
  if (metrics.fip !== null && metrics.xfip !== null) {
    dips = (1 - xfipWeight) * metrics.fip + xfipWeight * metrics.xfip;
  } else if (metrics.fip !== null) {
    dips = metrics.fip;
  } else if (metrics.xfip !== null) {
    dips = metrics.xfip;
  } else {
    dips = c.lgFIP;
    flags.push({
      code: "starter_no_fip",
      severity: "downgrade",
      message: "Could not compute FIP/xFIP; using league-average pitcher.",
    });
  }

  if (metrics.xfipEstimated) {
    flags.push({
      code: "xfip_estimated",
      severity: "info",
      message: "xFIP used a league fly-ball estimate (no batted-ball detail).",
    });
  }

  // 3. Regress toward league FIP by innings sample.
  const projFipNeutral = regressToMean(dips, c.lgFIP, ip, STARTER_FIP_PRIOR_IP);

  // 4. Park adjustment (a hitter's park, PF>100, raises expected runs).
  const parkFactor = input.parkFactor ?? 100;
  const projectedFip = projFipNeutral * (parkFactor / 100);

  // 5. Earned-run scale → total-run scale.
  const expectedRunsAllowedPer9 = projectedFip * RUNS_PER_EARNED_RUN;

  const reliability = reliabilityWeight(ip, STARTER_FIP_PRIOR_IP);
  if (ip < LOW_SAMPLE_IP) {
    flags.push({
      code: "starter_low_sample",
      severity: "warn",
      message: `Only ${ip.toFixed(1)} IP; projection heavily regressed to league mean.`,
    });
  }

  return {
    pitcherId: input.pitcherId ?? null,
    pitcherName: input.pitcherName ?? null,
    metrics,
    projectedFip: round2(projectedFip),
    expectedRunsAllowedPer9: round2(expectedRunsAllowedPer9),
    reliability: round2(reliability),
    flags,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
