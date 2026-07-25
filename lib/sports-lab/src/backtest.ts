/**
 * Step 8 — Backtesting.
 *
 * Replays logged predictions against the games' real final scores and measures
 * whether the system actually works (plan Section 4.4). This is the only stage
 * that can tell us whether any of the constants in `model/constants.ts` are
 * right, and the only honest basis for trusting a pick.
 *
 * What it measures, per the plan:
 *   - win rate of moneyline picks
 *   - over/under hit rate on totals
 *   - whether "positive-EV" bets would actually have been profitable
 *   - calibration — do games we call 60% really win about 60% of the time?
 *   - accuracy broken down by confidence rank (S should beat A should beat B)
 *
 * **Small samples lie.** A 20-bet sample tells you almost nothing, and a good
 * backtest report that hides that is worse than no report. Every summary
 * therefore carries `resolved` and `sufficientSample`, rates are `null` rather
 * than a fake `0` when nothing has resolved, and the rank-ordering check
 * returns `null` when there is not enough data to answer.
 */
import type { ConfidenceRank, FinalScore } from "./schemas";
import type { BetEvaluation, BetMarket, GameEvaluation } from "./odds/ev";
import type { ConfidenceAssessment } from "./confidence";
import type { SimulationResult } from "./model/simulate";
import { CONFIDENCE_ORDER } from "./flags";

/** How a settled bet finished. */
export type BetOutcome = "win" | "loss" | "push";

/**
 * A prediction as it was logged at the time, carrying everything needed to
 * settle and score it later. Odds are captured with the prediction because a
 * line moves — scoring against today's price would be revisionist.
 */
export interface PredictionRecord {
  gameId: string;
  rank: ConfidenceRank;
  /** Every market that was priced. */
  bets: BetEvaluation[];
  /** The subset that was actually recommended (positive EV, cleared minEdge). */
  recommended: BetEvaluation[];
  /** Model P(home win), kept for calibration of the headline number. */
  homeWinProbability: number;
}

/** Build a loggable record from the pipeline's Step 5–7 outputs. */
export function toPredictionRecord(
  confidence: ConfidenceAssessment,
  evaluation: GameEvaluation,
  simulation: SimulationResult,
): PredictionRecord {
  return {
    gameId: confidence.gameId,
    rank: confidence.rank,
    bets: evaluation.bets,
    recommended: evaluation.valueBets,
    homeWinProbability: simulation.moneyline.home,
  };
}

/**
 * Settle one bet against the final score.
 *
 * @throws {RangeError} when a market that needs a line was logged without one.
 */
export function settleBet(bet: BetEvaluation, score: FinalScore): BetOutcome {
  const margin = score.homeRuns - score.awayRuns;
  const total = score.homeRuns + score.awayRuns;

  switch (bet.market) {
    case "moneyline":
      // MLB has no ties, so a moneyline always resolves.
      if (bet.selection === "home") return margin > 0 ? "win" : "loss";
      return margin < 0 ? "win" : "loss";

    case "run_line": {
      if (bet.line === null) throw new RangeError("Run-line bet logged without a line");
      // Home lays the line; away receives it.
      if (bet.selection === "home") {
        if (margin > bet.line) return "win";
        if (margin === bet.line) return "push";
        return "loss";
      }
      if (margin < bet.line) return "win";
      if (margin === bet.line) return "push";
      return "loss";
    }

    case "total": {
      if (bet.line === null) throw new RangeError("Total bet logged without a line");
      if (total === bet.line) return "push";
      if (bet.selection === "over") return total > bet.line ? "win" : "loss";
      return total < bet.line ? "win" : "loss";
    }
  }
}

/** Profit in units for a 1-unit stake. A push returns the stake: zero profit. */
export function betProfit(bet: BetEvaluation, outcome: BetOutcome): number {
  if (outcome === "push") return 0;
  return outcome === "win" ? bet.decimalOdds - 1 : -1;
}

export interface SettledBet {
  gameId: string;
  rank: ConfidenceRank;
  bet: BetEvaluation;
  outcome: BetOutcome;
  profit: number;
  /** Whether this bet was one the system actually recommended. */
  recommended: boolean;
}

export interface BacktestSummary {
  bets: number;
  wins: number;
  losses: number;
  pushes: number;
  /** Bets that actually resolved (wins + losses). Pushes are not accuracy. */
  resolved: number;
  /** wins / resolved. Null when nothing resolved. */
  hitRate: number | null;
  /** Total staked, one unit per bet including pushes. */
  unitsStaked: number;
  unitsProfit: number;
  /** profit / staked. Null when nothing was staked. */
  roi: number | null;
  /** False when the sample is too small to read anything into. */
  sufficientSample: boolean;
}

export interface CalibrationBin {
  /** Bin bounds, e.g. 0.6 to 0.7. */
  lower: number;
  upper: number;
  count: number;
  /** Mean probability the model predicted inside this bin. */
  predicted: number | null;
  /** Share that actually won. */
  actual: number | null;
}

export interface BacktestReport {
  games: number;
  /** Every bet that was priced, settled. */
  overall: BacktestSummary;
  /** Only the bets the system recommended — the number that actually matters. */
  recommended: BacktestSummary;
  byRank: Record<ConfidenceRank, BacktestSummary>;
  byMarket: Record<BetMarket, BacktestSummary>;
  calibration: CalibrationBin[];
  /**
   * Brier score over resolved recommended bets — mean squared error of the
   * probabilities. Lower is better; 0.25 is what always guessing 50% scores.
   * Null when nothing resolved.
   */
  brierScore: number | null;
  /**
   * Does ROI actually fall as the rank falls (S ≥ A ≥ B ≥ C)? Null when fewer
   * than two ranks have a sufficient sample to compare — which is the common
   * case early on, and saying "null" beats inventing a verdict.
   */
  rankOrderingHolds: boolean | null;
  settled: SettledBet[];
}

export interface BacktestOptions {
  /** Minimum resolved bets before a summary is treated as meaningful. */
  minSample?: number;
  /** Number of calibration bins across [0, 1]. */
  calibrationBins?: number;
}

const DEFAULT_MIN_SAMPLE = 30;
const DEFAULT_BINS = 10;

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function summarise(settled: readonly SettledBet[], minSample: number): BacktestSummary {
  const wins = settled.filter((s) => s.outcome === "win").length;
  const losses = settled.filter((s) => s.outcome === "loss").length;
  const pushes = settled.filter((s) => s.outcome === "push").length;
  const resolved = wins + losses;
  const unitsStaked = settled.length;
  const unitsProfit = settled.reduce((sum, s) => sum + s.profit, 0);

  return {
    bets: settled.length,
    wins,
    losses,
    pushes,
    resolved,
    hitRate: resolved > 0 ? round(wins / resolved) : null,
    unitsStaked,
    unitsProfit: round(unitsProfit, 3),
    roi: unitsStaked > 0 ? round(unitsProfit / unitsStaked) : null,
    sufficientSample: resolved >= minSample,
  };
}

/**
 * Bin resolved bets by predicted probability and compare prediction to reality.
 * Uses `modelProbabilityNoPush`, the probability that the bet — having
 * resolved — wins, which is the quantity a resolved outcome actually tests.
 */
function calibrate(settled: readonly SettledBet[], bins: number): CalibrationBin[] {
  const resolved = settled.filter((s) => s.outcome !== "push");
  const width = 1 / bins;

  return Array.from({ length: bins }, (_, i) => {
    const lower = round(i * width, 6);
    const upper = round((i + 1) * width, 6);
    // The last bin includes 1.0 so a certainty is never dropped.
    const inBin = resolved.filter((s) => {
      const p = s.bet.modelProbabilityNoPush;
      return p >= lower && (i === bins - 1 ? p <= upper : p < upper);
    });

    if (inBin.length === 0) {
      return { lower, upper, count: 0, predicted: null, actual: null };
    }
    return {
      lower,
      upper,
      count: inBin.length,
      predicted: round(
        inBin.reduce((sum, s) => sum + s.bet.modelProbabilityNoPush, 0) / inBin.length,
      ),
      actual: round(inBin.filter((s) => s.outcome === "win").length / inBin.length),
    };
  });
}

/** Mean squared error between predicted probability and the binary outcome. */
function brier(settled: readonly SettledBet[]): number | null {
  const resolved = settled.filter((s) => s.outcome !== "push");
  if (resolved.length === 0) return null;
  const sum = resolved.reduce((acc, s) => {
    const outcome = s.outcome === "win" ? 1 : 0;
    return acc + (s.bet.modelProbabilityNoPush - outcome) ** 2;
  }, 0);
  return round(sum / resolved.length);
}

/**
 * Check that ROI falls monotonically as the rank falls. Only ranks with a
 * sufficient sample take part; fewer than two of those means we cannot tell.
 */
function checkRankOrdering(byRank: Record<ConfidenceRank, BacktestSummary>): boolean | null {
  const comparable = CONFIDENCE_ORDER.filter(
    (rank) => byRank[rank].sufficientSample && byRank[rank].roi !== null,
  );
  if (comparable.length < 2) return null;

  for (let i = 1; i < comparable.length; i++) {
    if (byRank[comparable[i - 1]].roi! < byRank[comparable[i]].roi!) return false;
  }
  return true;
}

/**
 * Replay logged predictions against final scores.
 *
 * @param entries Logged predictions paired with the game's real result.
 */
export function runBacktest(
  entries: ReadonlyArray<{ prediction: PredictionRecord; score: FinalScore }>,
  options: BacktestOptions = {},
): BacktestReport {
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const bins = options.calibrationBins ?? DEFAULT_BINS;

  const settled: SettledBet[] = [];
  for (const { prediction, score } of entries) {
    if (prediction.gameId !== score.gameId) {
      throw new RangeError(
        `Result mismatch: prediction is for ${prediction.gameId} but the score is ` +
          `for ${score.gameId}. Scoring a prediction against the wrong game would ` +
          `silently corrupt every metric.`,
      );
    }
    const recommendedLabels = new Set(prediction.recommended.map((b) => b.label));
    for (const bet of prediction.bets) {
      const outcome = settleBet(bet, score);
      settled.push({
        gameId: prediction.gameId,
        rank: prediction.rank,
        bet,
        outcome,
        profit: betProfit(bet, outcome),
        recommended: recommendedLabels.has(bet.label),
      });
    }
  }

  const recommended = settled.filter((s) => s.recommended);

  const byRank = Object.fromEntries(
    CONFIDENCE_ORDER.map((rank) => [
      rank,
      summarise(
        recommended.filter((s) => s.rank === rank),
        minSample,
      ),
    ]),
  ) as Record<ConfidenceRank, BacktestSummary>;

  const markets: BetMarket[] = ["moneyline", "run_line", "total"];
  const byMarket = Object.fromEntries(
    markets.map((market) => [
      market,
      summarise(
        recommended.filter((s) => s.bet.market === market),
        minSample,
      ),
    ]),
  ) as Record<BetMarket, BacktestSummary>;

  return {
    games: entries.length,
    overall: summarise(settled, minSample),
    recommended: summarise(recommended, minSample),
    byRank,
    byMarket,
    calibration: calibrate(recommended, bins),
    brierScore: brier(recommended),
    rankOrderingHolds: checkRankOrdering(byRank),
    settled,
  };
}

/** Render the backtest as a readable report. */
export function explainBacktest(report: BacktestReport): string[] {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const units = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}u`;

  const line = (label: string, s: BacktestSummary) =>
    `  ${label.padEnd(12)} ${String(s.bets).padStart(4)} bets  ` +
    `${String(s.wins)}-${String(s.losses)}-${String(s.pushes)}  ` +
    `hit ${pct(s.hitRate).padStart(6)}  ROI ${pct(s.roi).padStart(7)}  ` +
    `${units(s.unitsProfit)}${s.sufficientSample ? "" : "  (small sample)"}`;

  const lines = [
    `Backtest over ${report.games} games`,
    "",
    "All priced bets:",
    line("overall", report.overall),
    "",
    "Recommended bets only:",
    line("recommended", report.recommended),
    "",
    "By confidence rank:",
    ...CONFIDENCE_ORDER.map((rank) => line(rank, report.byRank[rank])),
    "",
    "By market:",
    ...(["moneyline", "run_line", "total"] as const).map((m) => line(m, report.byMarket[m])),
    "",
    `Brier score: ${report.brierScore === null ? "n/a" : report.brierScore.toFixed(4)}` +
      " (0.25 = always guessing 50%)",
    `Rank ordering holds: ${
      report.rankOrderingHolds === null
        ? "not enough data to say"
        : report.rankOrderingHolds
          ? "yes"
          : "NO — thresholds need recalibration"
    }`,
    "",
    "Calibration (predicted vs actual):",
    ...report.calibration
      .filter((b) => b.count > 0)
      .map(
        (b) =>
          `  ${(b.lower * 100).toFixed(0)}-${(b.upper * 100).toFixed(0)}%: ` +
          `predicted ${pct(b.predicted)}, actual ${pct(b.actual)} (n=${b.count})`,
      ),
  ];

  return lines;
}
