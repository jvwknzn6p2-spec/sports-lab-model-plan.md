/**
 * Bullpen feature builder — FIP-forward, fatigue-aware.
 *
 * Late-inning run prevention is projected from the relief staff's aggregate FIP
 * (again, not ERA), regressed to league mean, then adjusted for recent
 * workload. A gassed bullpen (heavy usage over the last few days, or key arms
 * unavailable) is penalized because tired relievers give up more runs than
 * their season line implies.
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

/** Innings-of-prior used to regress the bullpen's aggregate FIP. */
export const BULLPEN_FIP_PRIOR_IP = 60;

/** Recent-usage signals used to gauge bullpen fatigue. */
export interface BullpenWorkload {
  /** Relief innings thrown in the last 3 days. */
  last3DaysIP?: number;
  /** Count of high-leverage arms unavailable today (injury/rest/overuse). */
  unavailableKeyArms?: number;
}

export interface BullpenInput {
  teamId?: number;
  teamName?: string;
  season: number;
  /** Aggregate season relief-pitching line for the team. */
  line: RawPitchingLine;
  parkFactor?: number;
  workload?: BullpenWorkload;
}

export interface BullpenFeatures {
  teamId: number | null;
  teamName: string | null;
  metrics: PitchingMetrics;
  /** Season bullpen FIP regressed to league mean and park-adjusted. */
  projectedFip: number;
  /** Fatigue penalty added to expected runs per 9 (0 when fresh). */
  fatiguePenalty: number;
  /** Expected TOTAL runs allowed per 9 by the bullpen, fatigue-adjusted. */
  expectedRunsAllowedPer9: number;
  reliability: number;
  flags: DataQualityFlag[];
}

/**
 * Fatigue penalty in runs/9. Heavy 3-day usage and unavailable high-leverage
 * arms each nudge expected runs up. Deliberately conservative and capped.
 */
export function fatiguePenalty(workload: BullpenWorkload | undefined): {
  penalty: number;
  flags: DataQualityFlag[];
} {
  const flags: DataQualityFlag[] = [];
  if (!workload) return { penalty: 0, flags };
  let penalty = 0;

  const ip3 = workload.last3DaysIP ?? 0;
  // Above ~9 relief IP in 3 days the pen is stretched; ~0.06 R/9 per extra IP.
  if (ip3 > 9) {
    penalty += Math.min(0.5, (ip3 - 9) * 0.06);
    // The penalty is continuous from 9 IP, but the WARN label starts at 12:
    // ~3.5–4 relief IP per game is ordinary usage, so 9–12 IP over 3 days is
    // roughly league-normal and the 2026-08 standing audit showed the warn
    // firing on 55–62% of all games — a warning most games carry warns about
    // nothing. Below 12 the adjustment is still surfaced (info), so every
    // priced input stays visible; warn is reserved for a genuinely stretched
    // pen. Display banding only — the penalty math is unchanged either way.
    flags.push({
      code: "bullpen_heavy_usage",
      severity: ip3 > 12 ? "warn" : "info",
      message: `Bullpen threw ${ip3.toFixed(1)} IP over the last 3 days.`,
    });
  }

  const unavailable = workload.unavailableKeyArms ?? 0;
  if (unavailable > 0) {
    penalty += Math.min(0.6, unavailable * 0.2);
    flags.push({
      code: "bullpen_arms_unavailable",
      severity: "warn",
      message: `${unavailable} high-leverage reliever(s) unavailable.`,
    });
  }

  return { penalty: Math.round(penalty * 100) / 100, flags };
}

export function buildBullpenFeatures(input: BullpenInput): BullpenFeatures {
  const { line, season } = input;
  const c = getLeagueConstants(season);
  const metrics = computePitchingMetrics(line, season);
  const ip = inningsToDecimal(line.inningsPitched);
  const flags: DataQualityFlag[] = [];

  const observedFip = metrics.fip ?? c.lgFIP;
  if (metrics.fip === null) {
    flags.push({
      code: "bullpen_no_fip",
      severity: "downgrade",
      message: "Could not compute bullpen FIP; using league-average relief.",
    });
  }

  const projFipNeutral = regressToMean(
    observedFip,
    c.lgFIP,
    ip,
    BULLPEN_FIP_PRIOR_IP,
  );
  const parkFactor = input.parkFactor ?? 100;
  const projectedFip = projFipNeutral * (parkFactor / 100);

  const { penalty, flags: fatigueFlags } = fatiguePenalty(input.workload);
  flags.push(...fatigueFlags);

  const expectedRunsAllowedPer9 = projectedFip * RUNS_PER_EARNED_RUN + penalty;

  return {
    teamId: input.teamId ?? null,
    teamName: input.teamName ?? null,
    metrics,
    projectedFip: round2(projectedFip),
    fatiguePenalty: penalty,
    expectedRunsAllowedPer9: round2(expectedRunsAllowedPer9),
    reliability: round2(reliabilityWeight(ip, BULLPEN_FIP_PRIOR_IP)),
    flags,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
