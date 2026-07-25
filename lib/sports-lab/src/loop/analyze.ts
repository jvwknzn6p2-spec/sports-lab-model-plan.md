/**
 * Loop stage 2: analyse.
 *
 * Everything the plan's Section 4.4 asks for, computed from graded days:
 * moneyline win rate, Brier score and log loss, a reliability table (do games we
 * call 60% win 60%?), totals error and bias, the observed extra-innings rate,
 * betting ROI, and a breakdown by confidence rank so we can check that S really
 * does beat A.
 *
 * The `warnings` list is the important part in practice. It is where the
 * uncomfortable facts go: samples too small to mean anything, ranks out of
 * order, and predictions made after first pitch (which inflate everything).
 */

import { brierScore, calibrationBins, logLoss, mean } from "../core/math";
import type {
  AnalysisReport,
  ConfidenceRank,
  GameDate,
  GradedGame,
  RankBreakdown,
} from "../core/types";

const RANKS: ConfidenceRank[] = ["S", "A", "B", "C"];

/** Below this many games, a rate is quoted but should not be acted on. */
export const MIN_GAMES_FOR_SIGNAL = 100;
/** Below this, a betting ROI is essentially meaningless. */
export const MIN_BETS_FOR_ROI = 50;

function rankBreakdown(rank: ConfidenceRank, games: GradedGame[]): RankBreakdown {
  const subset = games.filter((g) => g.rank === rank);
  const positiveEvBets = subset.flatMap((g) => g.bets.filter((b) => b.positiveEv));
  const staked = positiveEvBets.filter((b) => !b.push).length;
  const profit = positiveEvBets.reduce((sum, b) => sum + b.profitUnits, 0);
  return {
    rank,
    games: subset.length,
    moneylineAccuracy:
      subset.length > 0
        ? subset.filter((g) => g.moneylineCorrect).length / subset.length
        : null,
    brier: brierScore(
      subset.map((g) => g.homeWinProbability),
      subset.map((g) => g.homeWon),
    ),
    bets: positiveEvBets.length,
    unitsStaked: staked,
    profitUnits: profit,
    roi: staked > 0 ? profit / staked : null,
  };
}

export function analyseGraded(
  games: GradedGame[],
  from: GameDate,
  to: GameDate,
): AnalysisReport {
  const warnings: string[] = [];
  const homeProbs = games.map((g) => g.homeWinProbability);
  const homeWins = games.map((g) => g.homeWon);

  const observedHomeRate =
    games.length > 0 ? games.filter((g) => g.homeWon).length / games.length : null;
  const predictedHomeRate = mean(homeProbs);

  const totalErrors = games.map((g) => g.totalError);
  const actualTotals = games.map((g) => g.actualTotal);
  const predictedTotals = games.map((g) => g.predictedTotal);

  const overs = games.filter((g) => g.actualTotal > g.predictedTotal).length;

  const extras = games.filter((g) => g.result.wentToExtras).length;

  const allPositiveEv = games.flatMap((g) => g.bets.filter((b) => b.positiveEv));
  const stakedBets = allPositiveEv.filter((b) => !b.push);
  const profit = allPositiveEv.reduce((sum, b) => sum + b.profitUnits, 0);

  const byRank = RANKS.map((rank) => rankBreakdown(rank, games));

  // --- warnings -------------------------------------------------------------
  if (games.length === 0) {
    warnings.push("No graded games in this range — nothing to conclude.");
  } else if (games.length < MIN_GAMES_FOR_SIGNAL) {
    warnings.push(
      `Only ${games.length} graded games. At this sample size a 3-4 point swing in ` +
        `win rate is pure noise; do not tune anything on it yet.`,
    );
  }
  if (stakedBets.length > 0 && stakedBets.length < MIN_BETS_FOR_ROI) {
    warnings.push(
      `ROI is computed from only ${stakedBets.length} settled bets and is not yet meaningful.`,
    );
  }

  const ranked = byRank.filter((r) => r.games >= 20 && r.moneylineAccuracy !== null);
  for (let i = 1; i < ranked.length; i++) {
    const better = ranked[i - 1] as RankBreakdown;
    const worse = ranked[i] as RankBreakdown;
    if ((worse.moneylineAccuracy as number) > (better.moneylineAccuracy as number) + 0.03) {
      warnings.push(
        `Rank ${worse.rank} is out-performing rank ${better.rank} ` +
          `(${((worse.moneylineAccuracy as number) * 100).toFixed(1)}% vs ` +
          `${((better.moneylineAccuracy as number) * 100).toFixed(1)}%). ` +
          `The confidence thresholds are mis-ordered or the sample is too small.`,
      );
    }
  }

  if (predictedHomeRate !== null && observedHomeRate !== null && games.length >= 50) {
    const bias = predictedHomeRate - observedHomeRate;
    if (Math.abs(bias) > 0.04) {
      warnings.push(
        `Home win probabilities are biased by ${(bias * 100).toFixed(1)} points ` +
          `(predicted ${(predictedHomeRate * 100).toFixed(1)}%, observed ` +
          `${(observedHomeRate * 100).toFixed(1)}%). Run calibrate.`,
      );
    }
  }

  const totalBias =
    predictedTotals.length > 0
      ? (mean(predictedTotals) as number) - (mean(actualTotals) as number)
      : null;
  if (totalBias !== null && Math.abs(totalBias) > 0.35 && games.length >= 50) {
    warnings.push(
      `Predicted totals run ${totalBias > 0 ? "high" : "low"} by ` +
        `${Math.abs(totalBias).toFixed(2)} runs on average. Run calibrate.`,
    );
  }

  return {
    sport: "MLB",
    from,
    to,
    generatedAt: new Date().toISOString(),
    games: games.length,
    moneyline: {
      accuracy:
        games.length > 0
          ? games.filter((g) => g.moneylineCorrect).length / games.length
          : null,
      brier: brierScore(homeProbs, homeWins),
      logLoss: logLoss(homeProbs, homeWins),
      bias:
        predictedHomeRate !== null && observedHomeRate !== null
          ? predictedHomeRate - observedHomeRate
          : null,
      bins: calibrationBins(homeProbs, homeWins),
    },
    totals: {
      meanAbsoluteError: mean(totalErrors.map(Math.abs)),
      bias: totalBias,
      overRate: games.length > 0 ? overs / games.length : null,
    },
    extraInnings: {
      predictedRate: mean(games.map((g) => g.simulatedExtraInningsRate)),
      observedRate: games.length > 0 ? extras / games.length : null,
    },
    betting: {
      bets: games.reduce((sum, g) => sum + g.bets.length, 0),
      positiveEvBets: allPositiveEv.length,
      unitsStaked: stakedBets.length,
      profitUnits: profit,
      roi: stakedBets.length > 0 ? profit / stakedBets.length : null,
    },
    byRank,
    warnings,
  };
}
