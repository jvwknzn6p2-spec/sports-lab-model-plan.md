/**
 * Shared types for Step-2 feature builders.
 *
 * A "feature" here is a model-ready input for the downstream baseline run model
 * (plan Section 4.1): a small, explainable number plus the reliability and
 * data-quality context needed to weight or downgrade it. Features never hide
 * missing data — they surface it as flags and lowered reliability.
 */

export type FlagSeverity = "info" | "warn" | "downgrade";

export interface DataQualityFlag {
  code: string;
  severity: FlagSeverity;
  message: string;
}

/** Convert earned-run rate (ERA/FIP scale) to a total-run rate. */
export const RUNS_PER_EARNED_RUN = 1 / 0.92; // ~8% of runs are unearned

/**
 * Reliability is a 0–1 weight expressing how much to trust a feature given its
 * sample size. It is the empirical-Bayes shrinkage weight: sample / (sample +
 * prior). 1.0 = full-season certainty, →0 = essentially no data.
 */
export function reliabilityWeight(sample: number, prior: number): number {
  if (sample <= 0) return 0;
  return sample / (sample + prior);
}

/**
 * Regress an observed rate toward a league prior using a pseudo-count prior.
 * projected = (sample·observed + prior·leagueMean) / (sample + prior)
 */
export function regressToMean(
  observed: number,
  leagueMean: number,
  sample: number,
  prior: number,
): number {
  if (sample <= 0) return leagueMean;
  return (sample * observed + prior * leagueMean) / (sample + prior);
}
