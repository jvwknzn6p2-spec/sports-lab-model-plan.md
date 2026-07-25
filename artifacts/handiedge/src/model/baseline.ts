/**
 * Transparent statistical baseline — the explainable ensemble member.
 * A fixed, documented expected-runs formula (no training). Ported from the
 * original v1.0 plan so every pick keeps a human-readable component.
 */

const LEAGUE_RUNS_PG = 4.5;
const LEAGUE_ERA = 4.2;
const HOME_FIELD_RUNS = 0.15;
const WIN_PROB_SCALE = 0.65;

function expectedRuns(
  batRunsPg: number,
  oppStarterEra: number,
  oppBullpenEra: number,
  parkFactor: number,
  windSigned: number,
): number {
  const oppPitchEra = 0.65 * oppStarterEra + 0.35 * oppBullpenEra;
  let base = 0.5 * batRunsPg + 0.5 * ((LEAGUE_RUNS_PG * oppPitchEra) / LEAGUE_ERA);
  base *= parkFactor;
  base *= 1 + 0.01 * windSigned;
  return Math.max(0, base);
}

export interface BaselineOutput {
  homeWinProb: number;
  predictedTotal: number;
}

export function baselinePredict(f: Record<string, number>): BaselineOutput {
  const homeExp =
    expectedRuns(
      f.home_bat_runs_pg!,
      f.away_starter_era!,
      f.away_bullpen_era!,
      f.park_factor!,
      f.wind_signed!,
    ) + HOME_FIELD_RUNS;
  const awayExp = expectedRuns(
    f.away_bat_runs_pg!,
    f.home_starter_era!,
    f.home_bullpen_era!,
    f.park_factor!,
    f.wind_signed!,
  );
  const formEdge = 0.4 * (f.home_form_l10! - f.away_form_l10!);
  const diff = homeExp - awayExp + formEdge;
  const homeWinProb = 1 / (1 + Math.exp(-WIN_PROB_SCALE * diff));
  return { homeWinProb, predictedTotal: homeExp + awayExp };
}
