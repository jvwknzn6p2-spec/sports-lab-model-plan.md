/**
 * Settlement Engine (Component 5).
 *
 * Grades locked predictions against actual results: moneyline right/wrong, total
 * over/under right/wrong, and realized profit on each flagged bet. The output is
 * the `settled_<date>.json` the Python Error Analysis engine consumes.
 *
 * Bet payout is reconstructed from the prediction itself — a bet's `edge` is
 * `modelProb - impliedProb`, so `impliedProb = selectionProb - edge` recovers
 * the market price without re-carrying raw odds.
 */

import type {
  LockFile,
  LockedPrediction,
  ResultsFile,
  SettledBet,
  SettledFile,
  SettledPrediction,
  TotalSide,
} from "./types.js";

/** Profit per 1 unit if the bet won, from the reconstructed implied price. */
function winProfit(selectionProb: number, edge: number): number {
  const implied = Math.min(0.99, Math.max(0.01, selectionProb - edge));
  return 1 / implied - 1;
}

function settleBets(
  record: LockedPrediction,
  moneylineCorrect: boolean,
  totalCorrect: boolean,
  totalPush: boolean,
): SettledBet[] {
  const bets: SettledBet[] = [];
  const total = record.prediction.model.total;
  const totalSelProb = record.picks.total === "over" ? total.overProb : total.underProb;

  for (const bet of record.prediction.model.ev.bets) {
    let selProb: number;
    let won: boolean;
    let push = false;

    if (bet.market === "moneyline") {
      selProb = record.picks.moneylineProb;
      won = moneylineCorrect;
    } else if (bet.market === "total") {
      selProb = totalSelProb;
      won = totalCorrect;
      push = totalPush;
    } else {
      // Run line and other markets aren't settled in this thin slice.
      continue;
    }

    const profit = push ? 0 : won ? winProfit(selProb, bet.edge) : -1;
    bets.push({
      selection: bet.selection,
      positive: bet.positive,
      profit: Number(profit.toFixed(4)),
    });
  }
  return bets;
}

export function settle(lockFile: LockFile, results: ResultsFile): SettledFile {
  const byId = new Map(results.results.map((r) => [r.gameId, r]));
  const settled: SettledPrediction[] = [];

  for (const record of lockFile.locked) {
    const result = byId.get(record.gameId);
    if (!result) continue; // ungraded (e.g. postponed) — skip

    const actualHomeWin = result.homeScore > result.awayScore;
    const moneylinePick = record.picks.moneyline;
    const moneylineCorrect = (moneylinePick === "home") === actualHomeWin;

    const totalRuns = result.homeScore + result.awayScore;
    const line = record.picks.totalLine;
    const totalPush = totalRuns === line;
    const actualOver = totalRuns > line;
    const totalPick: TotalSide = record.picks.total;
    const totalCorrect = !totalPush && (totalPick === "over") === actualOver;

    settled.push({
      gameId: record.gameId,
      homeWinProb: record.prediction.model.moneyline.homeWinProb,
      moneylinePick,
      moneylineCorrect,
      finalConfidence: record.review.finalConfidence,
      totalPick,
      totalCorrect,
      actualHomeWin,
      evBets: settleBets(record, moneylineCorrect, totalCorrect, totalPush),
    });
  }

  return { date: lockFile.date, settled };
}
