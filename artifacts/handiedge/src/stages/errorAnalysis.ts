/**
 * Stage 8 — Error Analysis Engine.
 * Measures realized performance from settled games: winner/handicap accuracy,
 * accuracy by confidence rank, Brier score, expected calibration error, and an
 * over/under-confidence signal. This is the evidence Self-Learning acts on.
 */
import {
  errorReportSchema,
  type ErrorReport,
  type SettledFile,
} from "../schemas.js";

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function ece(probs: number[], outcomes: number[], bins = 5): number {
  if (!probs.length) return 0;
  const buckets = Array.from({ length: bins }, () => ({ p: 0, y: 0, n: 0 }));
  for (let i = 0; i < probs.length; i++) {
    const idx = Math.min(bins - 1, Math.floor(probs[i]! * bins));
    buckets[idx]!.p += probs[i]!;
    buckets[idx]!.y += outcomes[i]!;
    buckets[idx]!.n += 1;
  }
  let total = 0;
  for (const b of buckets) {
    if (!b.n) continue;
    total += (b.n / probs.length) * Math.abs(b.p / b.n - b.y / b.n);
  }
  return total;
}

export function analyze(settledFile: SettledFile): ErrorReport {
  const games = settledFile.settled;
  const n = games.length;
  const plays = games.filter((g) => g.decision === "PLAY");

  const winnerGraded = games.filter((g) => g.winnerCorrect != null);
  const handicapGraded = games.filter((g) => g.handicapCorrect != null);

  const byConf: Record<string, { n: number; accuracy: number }> = {};
  for (const rank of ["S", "A", "B", "C"] as const) {
    const subset = winnerGraded.filter((g) => g.confidence === rank);
    if (subset.length) {
      byConf[rank] = {
        n: subset.length,
        accuracy: Number(mean(subset.map((g) => (g.winnerCorrect ? 1 : 0))).toFixed(4)),
      };
    }
  }

  const homeProbs = games.map((g) => g.homeWinProbForCalibration);
  const homeOutcomes = games.map((g) => (g.actualHomeWin ? 1 : 0));
  const brier = mean(homeProbs.map((p, i) => (p - homeOutcomes[i]!) ** 2));

  const overconf = mean(
    winnerGraded.map((g) => {
      const pickProb = g.pickedHome
        ? g.homeWinProbForCalibration
        : 1 - g.homeWinProbForCalibration;
      return pickProb - (g.winnerCorrect ? 1 : 0);
    }),
  );

  return errorReportSchema.parse({
    date: settledFile.date,
    runLabel: settledFile.runLabel,
    nGames: n,
    nPlays: plays.length,
    passRate: Number((n ? 1 - plays.length / n : 0).toFixed(4)),
    winnerAccuracy: Number(mean(winnerGraded.map((g) => (g.winnerCorrect ? 1 : 0))).toFixed(4)),
    handicapAccuracy: Number(
      mean(handicapGraded.map((g) => (g.handicapCorrect ? 1 : 0))).toFixed(4),
    ),
    accuracyByConfidence: byConf,
    brier: Number(brier.toFixed(4)),
    calibrationEce: Number(ece(homeProbs, homeOutcomes).toFixed(4)),
    overconfidenceSignal: Number(overconf.toFixed(4)),
  });
}
