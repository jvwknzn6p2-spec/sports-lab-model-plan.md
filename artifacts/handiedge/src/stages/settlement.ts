/**
 * Stage 7 — Settlement Engine.
 * Grades locked picks against final scores: winner, handicap cover, and the
 * home-win probability retained for calibration/error analysis. PASS games are
 * graded as "no pick" (null), not as losses.
 */
import {
  settledFileSchema,
  type LockedFile,
  type Results,
  type SettledFile,
  type SettledGame,
} from "../schemas.js";

export function settle(locked: LockedFile, results: Results): SettledFile {
  const byId = new Map(results.results.map((r) => [r.gameId, r]));
  const settled: SettledGame[] = [];

  for (const g of locked.games) {
    const r = byId.get(g.gameId);
    if (!r) continue;
    const margin = r.homeScore - r.awayScore;
    const actualHomeWin = margin > 0;

    const pickedHome = g.winner == null ? null : g.winner === g.homeAbbr;
    const winnerCorrect = pickedHome == null ? null : pickedHome === actualHomeWin;

    let handicapCorrect: boolean | null = null;
    if (g.handicapSide) {
      const favMargin = g.handicapFavorite === "home" ? margin : -margin;
      const favoriteCovers = favMargin > g.handicapLine;
      handicapCorrect = g.handicapSide === "favorite" ? favoriteCovers : !favoriteCovers;
    }

    settled.push({
      gameId: g.gameId,
      decision: g.decision,
      confidence: g.confidence,
      winProbability: g.winProbability,
      pickedHome,
      winnerCorrect,
      handicapPick: g.handicapPick,
      handicapCorrect,
      actualHomeWin,
      homeWinProbForCalibration: g.homeWinProbHome,
    });
  }

  return settledFileSchema.parse({ date: locked.date, runLabel: locked.runLabel, settled });
}
