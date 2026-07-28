/**
 * History aggregation — the "how am I actually doing?" view.
 *
 * Each `settle` run appends one SettlementReport to data/history.jsonl. This
 * module folds that log into cumulative accuracy: pick records, pooled Brier,
 * and stated-vs-actual calibration. Re-settling a date (e.g. after stragglers
 * finish) appends a newer report for the same date — only the LAST report per
 * date counts, so re-runs correct rather than double-count.
 */

import type { SettlementReport } from "./settle";

export interface HistorySummary {
  dates: number;
  gamesSettled: number;
  gamesPassed: number;
  winnerRecord: { wins: number; losses: number };
  handicapRecord: { wins: number; losses: number };
  totalRecord: { wins: number; losses: number };
  /** Win rate on non-PASS winner picks (null with no settled games). */
  winnerRate: number | null;
  /** Games-weighted mean Brier score (lower is better; 0.25 = coin flip). */
  meanBrier: number | null;
  /** Pooled stated probability vs. realized win rate (calibration check). */
  statedMean: number | null;
  actualRate: number | null;
  meanMarginError: number | null;
  meanTotalError: number | null;
  /** One line per date, oldest first. */
  perDate: Array<{
    date: string;
    settled: number;
    passed: number;
    winnerRecord: { wins: number; losses: number };
    meanBrier: number | null;
  }>;
}

export function aggregateHistory(reports: SettlementReport[]): HistorySummary {
  // Last report per date wins (re-settles supersede earlier ones).
  const byDate = new Map<string, SettlementReport>();
  for (const r of reports) byDate.set(r.date, r);
  const finals = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  let games = 0;
  let passed = 0;
  const winner = { wins: 0, losses: 0 };
  const handicap = { wins: 0, losses: 0 };
  const total = { wins: 0, losses: 0 };
  let brierSum = 0;
  let statedSum = 0;
  let marginErrSum = 0;
  let marginErrN = 0;
  let totalErrSum = 0;
  let totalErrN = 0;

  for (const r of finals) {
    games += r.gamesSettled;
    passed += r.gamesPassed;
    winner.wins += r.winnerRecord.wins;
    winner.losses += r.winnerRecord.losses;
    handicap.wins += r.handicapRecord.wins;
    handicap.losses += r.handicapRecord.losses;
    total.wins += r.totalRecord.wins;
    total.losses += r.totalRecord.losses;
    if (r.meanBrier !== null) brierSum += r.meanBrier * r.gamesSettled;
    if (r.statedVsActual)
      statedSum += r.statedVsActual.statedMean * r.gamesSettled;
    if (r.meanMarginError !== null) {
      const n = r.games.filter((g) => g.marginError !== null).length;
      marginErrSum += r.meanMarginError * n;
      marginErrN += n;
    }
    if (r.meanTotalError !== null) {
      const n = r.games.filter((g) => g.totalError !== null).length;
      totalErrSum += r.meanTotalError * n;
      totalErrN += n;
    }
  }

  const decided = winner.wins + winner.losses;
  return {
    dates: finals.length,
    gamesSettled: games,
    gamesPassed: passed,
    winnerRecord: winner,
    handicapRecord: handicap,
    totalRecord: total,
    winnerRate: decided === 0 ? null : round3(winner.wins / decided),
    meanBrier: games === 0 ? null : round3(brierSum / games),
    statedMean: games === 0 ? null : round3(statedSum / games),
    actualRate: decided === 0 ? null : round3(winner.wins / decided),
    meanMarginError:
      marginErrN === 0 ? null : round3(marginErrSum / marginErrN),
    meanTotalError: totalErrN === 0 ? null : round3(totalErrSum / totalErrN),
    perDate: finals.map((r) => ({
      date: r.date,
      settled: r.gamesSettled,
      passed: r.gamesPassed,
      winnerRecord: r.winnerRecord,
      meanBrier: r.meanBrier,
    })),
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
