/**
 * Loop stage 1: record.
 *
 * Fetch the final scores for a date and grade the predictions we saved for it.
 * Grading is exact — every bet carries a machine-readable `grading` clause, so a
 * run line of -1.5 and a total of 8 (which can push) settle correctly rather
 * than being inferred from a display string.
 */

import type {
  GameDate,
  GameResult,
  GradedBet,
  GradedGame,
  DailyPredictions,
} from "../core/types";
import type { GradedDay } from "../store/store";

export interface GradeOptions {
  predictions: DailyPredictions;
  results: GameResult[];
}

/** Did this bet win? `null` when it cannot be settled. */
function settleBet(bet: GradedBet["grading"], result: GameResult): {
  won: boolean | null;
  push: boolean;
} {
  const margin = result.homeScore - result.awayScore;
  switch (bet.kind) {
    case "moneyline": {
      if (margin === 0) return { won: null, push: true };
      return { won: bet.side === "home" ? margin > 0 : margin < 0, push: false };
    }
    case "runline": {
      const adjusted = margin + bet.homeHandicap;
      if (adjusted === 0) return { won: null, push: true };
      return { won: bet.side === "home" ? adjusted > 0 : adjusted < 0, push: false };
    }
    case "total": {
      const total = result.homeScore + result.awayScore;
      if (total === bet.line) return { won: null, push: true };
      return {
        won: bet.direction === "over" ? total > bet.line : total < bet.line,
        push: false,
      };
    }
    default:
      return { won: null, push: false };
  }
}

export function gradeDay(options: GradeOptions): GradedDay {
  const resultByPk = new Map(options.results.map((r) => [r.gamePk, r]));
  const games: GradedGame[] = [];

  for (const prediction of options.predictions.games) {
    const result = resultByPk.get(prediction.gamePk);
    if (!result) continue;

    const homeWon = result.homeScore > result.awayScore;
    const actualTotal = result.homeScore + result.awayScore;
    const bets: GradedBet[] = prediction.bets.map((bet) => {
      const settled = settleBet(bet.grading, result);
      const profitUnits = settled.push
        ? 0
        : settled.won === true
          ? bet.decimalOdds - 1
          : settled.won === false
            ? -1
            : 0;
      return { ...bet, won: settled.won, push: settled.push, profitUnits };
    });

    games.push({
      gamePk: prediction.gamePk,
      date: prediction.date,
      matchup: prediction.matchup,
      rank: prediction.confidence.rank,
      homeWinProbability: prediction.calibrated.homeWinProbability,
      predictedTotal: prediction.calibrated.predictedTotal,
      simulatedExtraInningsRate: prediction.simulation.extraInningsRate,
      result,
      homeWon,
      moneylineCorrect:
        prediction.moneylinePick.side === "home"
          ? homeWon
          : result.awayScore > result.homeScore,
      actualTotal,
      totalError: prediction.calibrated.predictedTotal - actualTotal,
      bets,
    });
  }

  return {
    date: options.predictions.date,
    gradedAt: new Date().toISOString(),
    games,
  };
}

export interface ScoreSummary {
  date: GameDate;
  predicted: number;
  results: number;
  graded: number;
  ungraded: string[];
}

export function summariseGrading(
  predictions: DailyPredictions,
  results: GameResult[],
  graded: GradedDay,
): ScoreSummary {
  const gradedPks = new Set(graded.games.map((g) => g.gamePk));
  return {
    date: predictions.date,
    predicted: predictions.games.length,
    results: results.length,
    graded: graded.games.length,
    ungraded: predictions.games
      .filter((g) => !gradedPks.has(g.gamePk))
      .map((g) => `${g.matchup} (no final score yet)`),
  };
}
