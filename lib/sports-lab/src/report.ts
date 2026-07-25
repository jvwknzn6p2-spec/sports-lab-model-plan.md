/**
 * Step 10 — Daily output and logging.
 *
 * Two deliverables from plan Section 6, built from the same data:
 *
 *   - A **human-readable report** — per-game prediction cards plus a daily
 *     summary, scannable at a glance and honest about uncertainty.
 *   - A **structured log** — JSON carrying everything needed to score these
 *     predictions later, so Step 8 can consume a logged slate directly.
 *
 * The log is not a rendering of the report; it is the record the report is a
 * view of. Anything the backtester needs lives in the log whether or not it is
 * printed, and the odds are captured as they were at prediction time (plan
 * Section 3: "timestamp everything").
 */
import type { PredictionRecord } from "./backtest";
import { toPredictionRecord } from "./backtest";
import type { ConfidenceRank } from "./schemas";
import { CONFIDENCE_ORDER } from "./flags";
import type { DossierInputs } from "./review/prompts";
import type { ReviewOutcome } from "./review/review";
import { explainReview } from "./review/review";
import { explainEvaluation } from "./odds/ev";

/** One game's complete pipeline output — Steps 3–9 for a single game. */
export interface GamePrediction extends DossierInputs {
  /** Null when the review layer did not run for this slate. */
  review: ReviewOutcome | null;
}

/** The rank the reader should act on: post-review when a review happened. */
export function finalRank(prediction: GamePrediction): ConfidenceRank {
  const { review, confidence } = prediction;
  return review !== null && review.reviewed ? review.rank : confidence.rank;
}

export interface ReportOptions {
  /**
   * Render a first-pitch time from the ISO timestamp. Defaults to UTC `HH:MM`
   * — deterministic, and honest that the library does not know the reader's
   * timezone. Pass a localizing formatter in the presentation layer.
   */
  formatTime?: (isoTimestamp: string) => string;
  /** Ranks eligible for the Best Bets section. Defaults to S and A. */
  bestBetRanks?: readonly ConfidenceRank[];
}

const DEFAULTS = {
  formatTime: (iso: string) => iso.slice(11, 16) + " UTC",
  bestBetRanks: ["S", "A"] as readonly ConfidenceRank[],
};

/** Rank order for sorting, best first. */
function rankIndex(rank: ConfidenceRank): number {
  return CONFIDENCE_ORDER.indexOf(rank);
}

/**
 * The handful of adjustments that actually moved this game, as prose.
 *
 * Reads the baseline's recorded step chain rather than re-deriving anything —
 * the "why" the model already wrote down, filtered to what mattered.
 */
export function keyFactors(prediction: GamePrediction, limit = 3): string[] {
  const { baseline } = prediction;
  const steps = [...baseline.home.steps, ...baseline.away.steps]
    .filter((s) => s.applied && s.label !== "League average")
    .filter((s) => Math.abs(s.multiplier - 1) >= 0.02)
    .sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1));

  // One entry per label — the same factor appears on both sides of the game.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const step of steps) {
    if (seen.has(step.label)) continue;
    seen.add(step.label);
    out.push(step.note);
    if (out.length >= limit) break;
  }
  return out;
}

/** Render one prediction card, in the layout from plan Section 6. */
export function renderGameCard(prediction: GamePrediction, options: ReportOptions = {}): string[] {
  const formatTime = options.formatTime ?? DEFAULTS.formatTime;
  const { game, simulation, evaluation, confidence, validation, review } = prediction;
  const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
  const home = game.home.name;
  const away = game.away.name;

  const rank = finalRank(prediction);
  const moneylinePick = simulation.moneyline.home >= 0.5 ? home : away;

  const rl = simulation.runLine;
  // Says which side is *likely* to cover. Deliberately not phrased as "no
  // edge": whether a side is mispriced is the Value block's job, and a market
  // can carry real value on the side less likely to cover.
  const runLineNote =
    rl.homeCoversMinus >= 0.5
      ? `→ Likely: ${home} -${rl.line}`
      : rl.awayCoversMinus >= 0.5
        ? `→ Likely: ${away} -${rl.line}`
        : "→ Neither side favored to cover";

  const totalLine =
    simulation.total.line === null || simulation.total.over === null
      ? `Total:       Predicted ${simulation.total.mean.toFixed(1)}  (no line posted)`
      : `Total:       Predicted ${simulation.total.mean.toFixed(1)}  (Line ${simulation.total.line})` +
        `     → Pick: ${simulation.total.over >= 0.5 ? "OVER" : "UNDER"} ` +
        `${pct(Math.max(simulation.total.over, simulation.total.under ?? 0))}`;

  const factors = keyFactors(prediction);
  const flags =
    validation.flags.length === 0
      ? "Flags:       none"
      : `Flags:       ${validation.flags.map((f) => f.code).join(", ")}`;

  const lines = [
    `${away} @ ${home} — ${formatTime(game.startTime)}`,
    `Confidence: ${rank}` +
      (review !== null && review.reviewed && review.rank !== review.rankBefore
        ? `  (statistical ${review.rankBefore}, AI review → ${review.rank})`
        : ""),
    "",
    `Moneyline:   ${home} ${pct(simulation.moneyline.home)}  |  ${away} ${pct(simulation.moneyline.away)}` +
      `     → Pick: ${moneylinePick}`,
    `Run line:    ${home} -${rl.line} covers ${pct(rl.homeCoversMinus)}        ${runLineNote}`,
    totalLine,
    "",
    ...explainEvaluation(evaluation),
    "",
    factors.length === 0
      ? "Key factors: nothing moved this game materially."
      : `Key factors: ${factors.join("\n             ")}`,
    flags,
  ];

  if (review !== null) {
    lines.push(...explainReview(review));
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Daily summary                                                              */
/* -------------------------------------------------------------------------- */

/** Sort a slate best-rank-first, then by edge within a rank. */
export function sortByConfidence(predictions: readonly GamePrediction[]): GamePrediction[] {
  return [...predictions].sort((a, b) => {
    const byRank = rankIndex(finalRank(a)) - rankIndex(finalRank(b));
    if (byRank !== 0) return byRank;
    return (b.confidence.primaryBet?.edge ?? -1) - (a.confidence.primaryBet?.edge ?? -1);
  });
}

/**
 * Render the daily summary: Best Bets, the full slate, and a data-issues note.
 *
 * A game whose AI review rejected the pick never appears in Best Bets, however
 * strong its statistical edge — that is the point of having the review.
 */
export function renderDailySummary(
  predictions: readonly GamePrediction[],
  options: ReportOptions = {},
): string[] {
  const bestBetRanks = options.bestBetRanks ?? DEFAULTS.bestBetRanks;
  const sorted = sortByConfidence(predictions);

  const bestBets = sorted.filter(
    (p) =>
      p.confidence.primaryBet !== null &&
      bestBetRanks.includes(finalRank(p)) &&
      !(p.review?.rejected ?? false),
  );

  const issues = sorted.filter(
    (p) =>
      p.validation.flags.some((f) => f.severity !== "info") ||
      (p.review !== null && p.review.reviewed && p.review.rank !== p.review.rankBefore),
  );

  const lines = [
    `BEST BETS (${bestBetRanks.join("/")} with positive EV)`,
  ];

  if (bestBets.length === 0) {
    lines.push("  None today. No pick cleared both the edge bar and the confidence bar.");
  } else {
    for (const p of bestBets) {
      const bet = p.confidence.primaryBet!;
      lines.push(
        `  [${finalRank(p)}] ${p.game.away.abbreviation} @ ${p.game.home.abbreviation}  ` +
          `${bet.label}  ${bet.edge >= 0 ? "+" : ""}${(bet.edge * 100).toFixed(1)}% edge  ` +
          `(EV ${bet.evPercent >= 0 ? "+" : ""}${bet.evPercent.toFixed(1)}%)`,
      );
    }
  }

  lines.push("", `ALL GAMES (${sorted.length}), by confidence`);
  for (const p of sorted) {
    const bet = p.confidence.primaryBet;
    lines.push(
      `  [${finalRank(p)}] ${p.game.away.abbreviation} @ ${p.game.home.abbreviation}  ` +
        (bet === null ? "no recommended bet" : `${bet.label}`),
    );
  }

  lines.push("", "DATA ISSUES AND DOWNGRADES");
  if (issues.length === 0) {
    lines.push("  None. Every game had complete, current data and held its rank.");
  } else {
    for (const p of issues) {
      const notes = [
        ...p.validation.flags.filter((f) => f.severity !== "info").map((f) => f.code),
        ...(p.review !== null && p.review.reviewed && p.review.rank !== p.review.rankBefore
          ? [`AI review ${p.review.rankBefore}→${p.review.rank}`]
          : []),
      ];
      lines.push(`  ${p.game.away.abbreviation} @ ${p.game.home.abbreviation}: ${notes.join(", ")}`);
    }
  }

  return lines;
}

export interface ReportMeta {
  /** When this slate was generated (ISO). */
  generatedAt: string;
  /** Which scheduled run produced it — see Step 11. */
  runMode: string;
}

/** The complete human-readable daily report. */
export function renderDailyReport(
  predictions: readonly GamePrediction[],
  meta: ReportMeta,
  options: ReportOptions = {},
): string {
  const header = [
    "=".repeat(72),
    `AI SPORTS LAB — DAILY REPORT`,
    `Generated ${meta.generatedAt} (${meta.runMode} run)`,
    "=".repeat(72),
    "",
    "Not financial advice. Baseball is high-variance: a 60% pick loses four",
    "times in ten. Low-confidence picks are informational only.",
    "",
  ];

  const cards = sortByConfidence(predictions).flatMap((p) => [
    "-".repeat(72),
    ...renderGameCard(p, options),
    "",
  ]);

  return [
    ...header,
    ...renderDailySummary(predictions, options),
    "",
    ...cards,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Structured log                                                             */
/* -------------------------------------------------------------------------- */

export interface LoggedGame {
  gameId: string;
  matchup: string;
  startTime: string;
  venueName: string;
  /** The rank acted on, after any review. */
  rank: ConfidenceRank;
  /** The rank the statistical layer produced, before review. */
  statisticalRank: ConfidenceRank;
  /** Step 3's data-quality ceiling. */
  dataCap: ConfidenceRank;
  completeness: number;
  flags: string[];
  reviewWarnings: string[];
  reviewRejected: boolean;
  /** Whether the weather behind this prediction was observed or forecast. */
  weatherMode: string;
  expectedTotal: number;
  expectedMargin: number;
  simulationSeed: number;
  simulationIterations: number;
  sportsbook: string;
  oddsFetchedAt: string;
  /** Everything Step 8 needs to settle and score this game. */
  record: PredictionRecord;
}

export interface DailyLog {
  generatedAt: string;
  runMode: string;
  gameCount: number;
  games: LoggedGame[];
}

/**
 * Build the structured log for a slate.
 *
 * Carries the simulation seed and the odds timestamp so a prediction can be
 * reproduced exactly and scored against the price that was actually available
 * — not the price the line moved to afterwards.
 */
export function toDailyLog(
  predictions: readonly GamePrediction[],
  meta: ReportMeta,
): DailyLog {
  return {
    generatedAt: meta.generatedAt,
    runMode: meta.runMode,
    gameCount: predictions.length,
    games: sortByConfidence(predictions).map((p) => ({
      gameId: p.game.gameId,
      matchup: `${p.game.away.abbreviation} @ ${p.game.home.abbreviation}`,
      startTime: p.game.startTime,
      venueName: p.game.venueName,
      rank: finalRank(p),
      statisticalRank: p.confidence.rank,
      dataCap: p.confidence.dataCap,
      completeness: p.validation.completeness,
      flags: p.validation.flags.map((f) => f.code),
      reviewWarnings: p.review?.warnings ?? [],
      reviewRejected: p.review?.rejected ?? false,
      weatherMode: p.baseline.weatherMode,
      expectedTotal: p.baseline.expectedTotal,
      expectedMargin: p.baseline.expectedMargin,
      simulationSeed: p.simulation.seed,
      simulationIterations: p.simulation.iterations,
      sportsbook: p.evaluation.sportsbook,
      oddsFetchedAt: p.evaluation.oddsFetchedAt,
      // The rank on the record is the one acted on, so a backtest scores what
      // was actually recommended rather than what the model alone suggested.
      record: { ...toPredictionRecord(p.confidence, p.evaluation, p.simulation), rank: finalRank(p) },
    })),
  };
}

/** Serialize the log as pretty-printed JSON, ready to write to disk. */
export function serializeDailyLog(log: DailyLog): string {
  return JSON.stringify(log, null, 2);
}
