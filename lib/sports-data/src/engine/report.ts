/**
 * History aggregation — the "how am I actually doing?" view.
 *
 * Each `settle` run appends one SettlementReport to data/history.jsonl. This
 * module folds that log into cumulative accuracy: pick records, pooled Brier,
 * stated-vs-actual calibration — and the DECOMPOSITIONS a single mean hides.
 * The 2026-08 audit found a −24pt calibration failure in the 65–70% band and
 * an inverted confidence ladder (S hitting 41% under A's 67%) sitting invisibly
 * inside a headline gap of 2pt; the per-bucket and per-confidence views exist
 * so that class of problem surfaces in the daily report instead of waiting
 * for the next audit. Re-settling a date (e.g. after stragglers finish)
 * appends a newer report for the same date — only the LAST report per date
 * counts, so re-runs correct rather than double-count.
 */

import type { Confidence } from "./decision";
import { breakEvenProbability } from "./ev";
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
  /**
   * Per-market calibration: what we said vs. what actually happened. This is
   * the number that tells you whether the HANDICAP model is trustworthy
   * independently of the moneyline model.
   */
  handicapCalibration: MarketCalibration | null;
  totalCalibration: MarketCalibration | null;
  /**
   * The handicap book's bottom line, in units staked after commission, and
   * whether that bottom line is yet distinguishable from luck. The verdict
   * is computed on the PROFITS themselves, not the win-rate: a 半-line book
   * can post a fine-looking record of partial-stake "wins" that pay well
   * under +0.9 each, and a win-rate test against the full-unit break-even
   * would bless it while the units drain away. Mean profit per bet against
   * zero is immune to that — zero profit IS break-even, whatever the stake
   * structure. The win-rate interval is still reported (handicapAssessment)
   * as context, but the significance claim belongs to the money.
   */
  handicapProfitTotal: number | null;
  handicapRoi: number | null;
  handicapProfitAssessment: ProfitAssessment | null;
  /** Win-rate context (Wilson CI vs the full-unit break-even). */
  handicapAssessment: BinomialAssessment | null;
  /**
   * Calibration curve, per stated-probability band. The overall stated-vs-
   * actual gap can be ~0 while one band is +4pt and another −24pt — this is
   * the view that catches it.
   */
  winnerBuckets: CalibrationBucket[];
  handicapBuckets: CalibrationBucket[];
  /**
   * Record per confidence band (games whose history predates the field are
   * skipped). S underperforming B is a model problem, not a luck problem —
   * and it is invisible in every aggregate above.
   */
  byConfidence: ConfidenceRecord[];
  /** One line per date, oldest first. */
  perDate: Array<{
    date: string;
    settled: number;
    passed: number;
    winnerRecord: { wins: number; losses: number };
    meanBrier: number | null;
  }>;
}

export interface MarketCalibration {
  /** Scored bets in this market. */
  n: number;
  statedMean: number;
  actualRate: number;
  /** Mean Brier of this market's own stated probabilities. */
  meanBrier: number;
}

export interface CalibrationBucket {
  /** Stated-probability band [lo, hi). */
  lo: number;
  hi: number;
  n: number;
  statedMean: number;
  actualRate: number;
  /** actualRate − statedMean; sizable negative = overconfident band. */
  gap: number;
  /**
   * Set when the band has enough bets (≥10) and a gap worth flagging
   * (|gap| ≥ 10pt). Decided here, once, so every renderer shows the same
   * warning for the same data.
   */
  flag: "overconfident" | "underconfident" | null;
}

export interface ConfidenceRecord {
  confidence: Confidence;
  n: number;
  wins: number;
  losses: number;
  rate: number;
  /** Handicap P&L of these picks, units after commission. */
  profit: number;
}

/**
 * Which side of "explainable as luck" a record sits on. Three-valued on
 * purpose: a one-sided "significant or not" collapses "provably losing"
 * into "inconclusive", and a report that describes a z of −4 as *not yet
 * distinguishable from luck* is lying in the direction that costs money.
 */
export type SignificanceVerdict = "ahead" | "behind" | "inconclusive";

export interface BinomialAssessment {
  n: number;
  rate: number;
  /** 95% Wilson score interval for the true hit rate. */
  ci95: { lo: number; hi: number };
  /** The commission break-even the record is tested against. */
  breakEven: number;
  /** z of the observed rate vs. the break-even (sign preserved). */
  zVsBreakEven: number;
  verdict: SignificanceVerdict;
  /** Convenience: verdict === "ahead". */
  significant: boolean;
}

export interface ProfitAssessment {
  /** Settled handicap stakes (each contributes its realized profit). */
  n: number;
  /** Mean profit per unit staked — the ROI. */
  meanProfit: number;
  /** One-sample z of the mean profit against zero. */
  z: number;
  verdict: SignificanceVerdict;
}

const Z_95_ONE_SIDED = 1.645;

function verdictOf(z: number): SignificanceVerdict {
  return z >= Z_95_ONE_SIDED
    ? "ahead"
    : z <= -Z_95_ONE_SIDED
      ? "behind"
      : "inconclusive";
}

/**
 * Is the mean realized profit per bet distinguishable from zero? Zero IS
 * break-even here — `handicapProfit` already nets the commission and any
 * partial 半-line stakes — so this is the significance test that survives
 * every stake structure the book will ever hold.
 */
export function assessProfit(profits: number[]): ProfitAssessment | null {
  const n = profits.length;
  if (n < 2) return null; // no variance estimate from fewer than two stakes
  const mean = profits.reduce((a, b) => a + b, 0) / n;
  const variance =
    profits.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const z = se === 0 ? 0 : mean / se;
  return {
    n,
    meanProfit: round3(mean),
    z: Math.round(z * 100) / 100,
    verdict: verdictOf(z),
  };
}

/**
 * Wilson score interval — behaves at small n and near-0/1 rates, where the
 * naive normal interval lies (a 7-of-10 run "significant" at ±0 width).
 */
export function wilson95(wins: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const z = 1.959964;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lo: round3(Math.max(0, (centre - half) / denom)),
    hi: round3(Math.min(1, (centre + half) / denom)),
  };
}

export function assessRecord(wins: number, losses: number): BinomialAssessment | null {
  const n = wins + losses;
  if (n === 0) return null;
  const p0 = breakEvenProbability();
  const rate = wins / n;
  const z = (rate - p0) / Math.sqrt((p0 * (1 - p0)) / n);
  const verdict = verdictOf(z);
  return {
    n,
    rate: round3(rate),
    ci95: wilson95(wins, n),
    breakEven: round3(p0),
    zVsBreakEven: Math.round(z * 100) / 100,
    verdict,
    significant: verdict === "ahead",
  };
}

/** Stated-probability bands for the calibration curve. */
const BUCKETS: Array<[number, number]> = [
  [0.5, 0.55],
  [0.55, 0.6],
  [0.6, 0.65],
  [0.65, 0.7],
  [0.7, 1.000001],
];

function bucketize(samples: ScoredSample[]): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (const [lo, hi] of BUCKETS) {
    const inBand = samples.filter((s) => s.stated >= lo && s.stated < hi);
    if (inBand.length === 0) continue;
    const statedMean =
      inBand.reduce((a, s) => a + s.stated, 0) / inBand.length;
    const actualRate =
      inBand.filter((s) => s.correct).length / inBand.length;
    const gap = actualRate - statedMean;
    out.push({
      lo,
      hi: Math.min(hi, 1),
      n: inBand.length,
      statedMean: round3(statedMean),
      actualRate: round3(actualRate),
      gap: round3(gap),
      flag:
        inBand.length >= 10 && gap <= -0.1
          ? "overconfident"
          : inBand.length >= 10 && gap >= 0.1
            ? "underconfident"
            : null,
    });
  }
  return out;
}

interface ScoredSample {
  stated: number;
  correct: boolean;
}

function scored(
  samples: Array<{ stated: number | null; correct: boolean | null }>,
): ScoredSample[] {
  return samples.filter(
    (s): s is ScoredSample => s.stated !== null && s.correct !== null,
  );
}

function marketCalibration(
  samples: Array<{ stated: number | null; correct: boolean | null }>,
): MarketCalibration | null {
  const sc = scored(samples);
  if (sc.length === 0) return null;
  return {
    n: sc.length,
    statedMean: round3(sc.reduce((a, s) => a + s.stated, 0) / sc.length),
    actualRate: round3(sc.filter((s) => s.correct).length / sc.length),
    meanBrier: round3(
      sc.reduce((a, s) => a + (s.stated - (s.correct ? 1 : 0)) ** 2, 0) /
        sc.length,
    ),
  };
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
  const handicapSamples: Array<{
    stated: number | null;
    correct: boolean | null;
  }> = [];
  const totalSamples: Array<{
    stated: number | null;
    correct: boolean | null;
  }> = [];
  const winnerSamples: Array<{
    stated: number | null;
    correct: boolean | null;
  }> = [];
  let profitSum = 0;
  let profitN = 0;
  const allProfits: number[] = [];
  const byConf = new Map<
    Confidence,
    { n: number; wins: number; losses: number; profit: number }
  >();

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
    for (const g of r.games) {
      handicapSamples.push({
        stated: g.handicapProbability,
        correct: g.handicapCorrect,
      });
      totalSamples.push({
        stated: g.totalProbability,
        correct: g.totalCorrect,
      });
      winnerSamples.push({
        stated: g.statedProbability,
        correct: g.winnerCorrect,
      });
      if (g.handicapProfit !== null) {
        profitSum += g.handicapProfit;
        profitN++;
        allProfits.push(g.handicapProfit);
      }
      if (g.confidence != null) {
        const e = byConf.get(g.confidence) ?? {
          n: 0,
          wins: 0,
          losses: 0,
          profit: 0,
        };
        // The record needs a decided winner market; the MONEY does not — a
        // tied final still settles its handicap stake, and dropping that
        // loss from the confidence row would make the rows stop reconciling
        // with handicapProfitTotal.
        if (g.winnerCorrect !== null) {
          e.n++;
          if (g.winnerCorrect) e.wins++;
          else e.losses++;
        }
        if (g.handicapProfit !== null) e.profit += g.handicapProfit;
        byConf.set(g.confidence, e);
      }
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
    handicapCalibration: marketCalibration(handicapSamples),
    totalCalibration: marketCalibration(totalSamples),
    handicapProfitTotal: profitN === 0 ? null : round3(profitSum),
    handicapRoi: profitN === 0 ? null : round3(profitSum / profitN),
    handicapProfitAssessment: assessProfit(allProfits),
    handicapAssessment: assessRecord(handicap.wins, handicap.losses),
    winnerBuckets: bucketize(scored(winnerSamples)),
    handicapBuckets: bucketize(scored(handicapSamples)),
    byConfidence: (["S", "A", "B", "C"] as const)
      .filter((c) => (byConf.get(c)?.n ?? 0) > 0)
      .map((c) => {
        const e = byConf.get(c)!;
        return {
          confidence: c,
          n: e.n,
          wins: e.wins,
          losses: e.losses,
          rate: round3(e.wins / e.n),
          profit: round3(e.profit),
        };
      }),
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
