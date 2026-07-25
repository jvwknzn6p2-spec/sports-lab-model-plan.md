/**
 * Step 11 — The daily workflow.
 *
 * Runs the full pipeline over a slate: validate → baseline → simulate → EV →
 * confidence → AI review → report + log. This is the function a scheduler
 * calls; scheduling itself is deployment-specific and lives outside the
 * library (see the README).
 *
 * Two properties matter more than the sequencing:
 *
 * **One broken game must not take down the slate.** Every game is wrapped, and
 * a failure is recorded against that game and reported — the other fourteen
 * still produce predictions. A pipeline that throws on the first missing
 * starter would be useless in practice, because on any given morning some game
 * is missing something.
 *
 * **Re-runs are reproducible.** Each game's simulation seed is derived from its
 * game id, so the same slate re-run gives the same probabilities, and two games
 * in one slate never share a seed.
 */
import type { CoreGame, GameContext, GameOdds } from "./schemas";
import { validateGame, type ValidateOptions } from "./validate";
import { computeBaseline, BaselineInputError } from "./model/baseline";
import { simulateGame } from "./model/simulate";
import { evaluateOdds } from "./odds/ev";
import { assignConfidence } from "./confidence";
import { reviewGame, type ReviewOptions } from "./review/review";
import { ruleBasedReviewer, type Reviewer } from "./review/reviewers";
import {
  renderDailyReport,
  toDailyLog,
  type DailyLog,
  type GamePrediction,
  type ReportMeta,
  type ReportOptions,
} from "./report";
import { DEFAULT_ITERATIONS } from "./model/constants";

/**
 * Which scheduled run this is (plan Section 5): an early run that is useful but
 * may predate confirmed starters, and an optional refresh close to first pitch.
 */
export type RunMode = "morning" | "pregame";

/** One game's inputs, as the fetch layer hands them over. */
export interface SlateEntry {
  game: CoreGame;
  context: GameContext;
  /** Null when no book had posted this game yet. */
  odds: GameOdds | null;
}

export interface PipelineFailure {
  gameId: string;
  /** Which stage threw, so a failure points at something actionable. */
  stage: "validate" | "baseline" | "simulate" | "evaluate" | "confidence" | "review";
  message: string;
}

export interface PipelineOptions {
  runMode?: RunMode;
  /** Reference "now" for staleness checks and the report timestamp. */
  asOf?: string;
  /** Simulations per game. Defaults to the plan's 10,000. */
  iterations?: number;
  /** Mixed into each game's derived seed, to vary a whole slate if needed. */
  seedBase?: number;
  /** Minimum edge before a bet is flagged as value. */
  minEdge?: number;
  /** Review backend. Defaults to the deterministic reviewer. */
  reviewer?: Reviewer;
  /** Set false to skip the AI review entirely. */
  runReview?: boolean;
  /** Passed through to the review layer. */
  reviewOptions?: Omit<ReviewOptions, "reviewer">;
  /** Passed through to the report renderer. */
  reportOptions?: ReportOptions;
}

export interface PipelineResult {
  meta: ReportMeta;
  /** Games that produced a full prediction. */
  predictions: GamePrediction[];
  /** Games that could not be predicted, and why. */
  failures: PipelineFailure[];
  /** The human-readable daily report. */
  report: string;
  /** The structured log, ready to persist for Step 8. */
  log: DailyLog;
}

/**
 * Staleness tolerance by run mode.
 *
 * A morning run legitimately works from data pulled that morning. By the
 * pre-game refresh, lineups and weather have moved — data still sitting at
 * twelve hours old is stale in a way it was not at 8am, and the tighter
 * threshold is what makes the refresh worth running at all.
 */
const STALE_HOURS: Record<RunMode, number> = {
  morning: 24,
  pregame: 6,
};

/**
 * Derive a stable simulation seed from a game id (FNV-1a).
 *
 * Deterministic so a re-run of the same slate reproduces exactly, and distinct
 * per game so one slate's games do not share a random stream.
 */
export function seedForGame(gameId: string, base = 0): number {
  let hash = 0x811c9dc5 ^ (base >>> 0);
  for (let i = 0; i < gameId.length; i++) {
    hash ^= gameId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A GameOdds with every market unposted — used when no book has priced a game. */
function emptyOdds(gameId: string, fetchedAt: string): GameOdds {
  return {
    gameId,
    sportsbook: "none",
    moneyline: null,
    runLine: null,
    total: null,
    fetchedAt,
  };
}

/**
 * Run the full daily pipeline over a slate.
 *
 * @param slate Every game to predict, with its context and current odds.
 */
export async function runDailyPipeline(
  slate: readonly SlateEntry[],
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const runMode = options.runMode ?? "morning";
  const asOf = options.asOf ?? new Date().toISOString();
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const reviewer = options.reviewer ?? ruleBasedReviewer;
  const runReview = options.runReview ?? true;

  const validateOptions: ValidateOptions = {
    asOf,
    staleAfterHours: STALE_HOURS[runMode],
  };

  const predictions: GamePrediction[] = [];
  const failures: PipelineFailure[] = [];

  for (const entry of slate) {
    const { game, context } = entry;
    const odds = entry.odds ?? emptyOdds(game.gameId, asOf);

    let stage: PipelineFailure["stage"] = "validate";
    try {
      const validation = validateGame(game, context, validateOptions);

      stage = "baseline";
      const baseline = computeBaseline(game, context);

      stage = "simulate";
      const simulation = simulateGame(baseline, {
        iterations,
        seed: seedForGame(game.gameId, options.seedBase),
        // Simulate at exactly the lines the book posted, or Step 6 will
        // (deliberately) refuse to price them against a different line.
        totalLine: odds.total?.line ?? null,
        runLine: odds.runLine?.line,
      });

      stage = "evaluate";
      const evaluation = evaluateOdds(
        simulation,
        odds,
        { home: game.home.name, away: game.away.name },
        { minEdge: options.minEdge },
      );

      stage = "confidence";
      const confidence = assignConfidence({ validation, baseline, simulation, evaluation });

      stage = "review";
      const inputs = { game, context, validation, baseline, simulation, evaluation, confidence };
      const review = runReview
        ? await reviewGame(inputs, { ...options.reviewOptions, reviewer })
        : null;

      predictions.push({ ...inputs, review });
    } catch (error) {
      // A game the model genuinely cannot run is expected, not exceptional:
      // record it, report it, and keep going through the rest of the slate.
      const message =
        error instanceof BaselineInputError
          ? `Cannot model this game — ${error.missing.join(", ")} missing.`
          : error instanceof Error
            ? error.message
            : String(error);
      failures.push({ gameId: game.gameId, stage, message });
    }
  }

  const meta: ReportMeta = { generatedAt: asOf, runMode };
  const report = renderDailyReport(predictions, meta, options.reportOptions);

  return {
    meta,
    predictions,
    failures,
    report: appendFailures(report, failures),
    log: toDailyLog(predictions, meta),
  };
}

/**
 * Append un-predictable games to the report. They are the most important thing
 * on the page for anyone deciding whether to trust the slate, so they are
 * printed rather than left in a return value nobody renders.
 */
function appendFailures(report: string, failures: readonly PipelineFailure[]): string {
  if (failures.length === 0) return report;
  return [
    report,
    "-".repeat(72),
    `GAMES WITH NO PREDICTION (${failures.length})`,
    ...failures.map((f) => `  ${f.gameId} — failed at ${f.stage}: ${f.message}`),
    "",
  ].join("\n");
}
