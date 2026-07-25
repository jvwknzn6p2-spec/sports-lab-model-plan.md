/**
 * Step 9 — Review prompts and the shared game dossier.
 *
 * **The caching strategy lives here.** All three reviewers look at the same
 * game, so the dossier is built once and placed as the *first* system block,
 * with the cache breakpoint on it. Each reviewer's role instructions go in a
 * *second* block, after the breakpoint.
 *
 * Prompt caching is a prefix match, so this ordering means the three agents
 * share one cached prefix instead of each paying full price for the same
 * dossier. Putting the role instructions first — the more natural-looking
 * layout — would give three distinct prefixes and cache nothing.
 *
 * Note the floor: a prefix must reach 512 tokens on Claude Opus 5 to cache at
 * all. A sparse dossier may fall under it and silently not cache; that costs
 * nothing extra, it just doesn't save anything.
 */
import type { ConfidenceAssessment } from "../confidence";
import type { BaselineResult } from "../model/baseline";
import type { SimulationResult } from "../model/simulate";
import type { GameEvaluation } from "../odds/ev";
import type { ValidationResult } from "../validate";
import type { CoreGame, GameContext } from "../schemas";
import { explainEstimate } from "../model/baseline";
import { explainSimulation } from "../model/simulate";
import { explainEvaluation } from "../odds/ev";
import { explainConfidence } from "../confidence";
import type { ReviewAgent } from "./schemas";

export interface DossierInputs {
  game: CoreGame;
  context: GameContext;
  validation: ValidationResult;
  baseline: BaselineResult;
  simulation: SimulationResult;
  evaluation: GameEvaluation;
  confidence: ConfidenceAssessment;
}

/**
 * Render everything the pipeline computed into one plain-text dossier.
 *
 * This is deliberately the *rendered* explanations rather than raw JSON: the
 * step traces already read as prose, and they carry the reasoning a reviewer
 * needs. It is also the same text a human would see in the daily report, so
 * the reviewers and the reader are looking at the same thing.
 */
export function buildDossier(inputs: DossierInputs): string {
  const { game, context, validation, baseline, simulation, evaluation, confidence } = inputs;
  const labels = { home: game.home.name, away: game.away.name };

  const flags =
    validation.flags.length === 0
      ? "  none"
      : validation.flags.map((f) => `  [${f.severity}] ${f.code} (${f.field}): ${f.message}`).join("\n");

  return [
    `GAME: ${game.away.name} @ ${game.home.name}`,
    `Venue: ${game.venueName}   First pitch: ${game.startTime}`,
    "",
    "STARTERS",
    `  ${game.home.abbreviation}: ${game.homeStarter?.name ?? "NOT NAMED"}` +
      (game.homeStarter ? ` (${game.homeStarter.seasonEra ?? "?"} ERA, confirmed=${game.homeStarter.confirmed})` : ""),
    `  ${game.away.abbreviation}: ${game.awayStarter?.name ?? "NOT NAMED"}` +
      (game.awayStarter ? ` (${game.awayStarter.seasonEra ?? "?"} ERA, confirmed=${game.awayStarter.confirmed})` : ""),
    "",
    "CONTEXT",
    `  Weather: ${context.weather.weatherMode.toUpperCase()} — ${context.weather.temperatureF ?? "?"}°F, ` +
      `wind ${context.weather.windRelative ?? "?"} ${context.weather.windSpeedMph ?? "?"}mph, ` +
      `roof ${context.weather.roofState}, precip ${context.weather.precipitationChance ?? "?"}`,
    `  Ballpark: runs factor ${context.ballpark.runsFactor}` +
      (context.ballpark.isNeutralFallback ? " (NEUTRAL FALLBACK — venue not in table)" : ""),
    `  Home injuries: ${describeInjuries(context, "home")}`,
    `  Away injuries: ${describeInjuries(context, "away")}`,
    `  Home form: ${context.recentForm.home.wins}-${context.recentForm.home.losses} ` +
      `over ${context.recentForm.home.sampleSize} games`,
    `  Away form: ${context.recentForm.away.wins}-${context.recentForm.away.losses} ` +
      `over ${context.recentForm.away.sampleSize} games`,
    "",
    "DATA VALIDATION",
    `  Confidence cap: ${validation.confidenceCap}   Completeness: ${Math.round(validation.completeness * 100)}%`,
    "  Flags:",
    flags,
    "",
    "BASELINE MODEL (expected runs, step by step)",
    ...explainEstimate(baseline.home).map((l) => `  ${l}`),
    ...explainEstimate(baseline.away).map((l) => `  ${l}`),
    "",
    "SIMULATION",
    ...explainSimulation(simulation, labels).map((l) => `  ${l}`),
    `  Iterations: ${simulation.iterations}  Seed: ${simulation.seed}`,
    "",
    "MARKET AND EXPECTED VALUE",
    `  Sportsbook: ${evaluation.sportsbook}   Odds fetched: ${evaluation.oddsFetchedAt}`,
    ...explainEvaluation(evaluation).map((l) => `  ${l}`),
    "",
    "CONFIDENCE (statistical layer)",
    ...explainConfidence(confidence).map((l) => `  ${l}`),
  ].join("\n");
}

function describeInjuries(context: GameContext, side: "home" | "away"): string {
  const report = context.injuries[side];
  const out = report.injuries.filter((i) => i.status === "out");
  const lineup = report.lineupConfirmed ? "lineup confirmed" : "LINEUP NOT CONFIRMED";
  if (out.length === 0) return `none out, ${lineup}`;
  return `${out.map((i) => `${i.name} (${i.impact})`).join(", ")} out, ${lineup}`;
}

/** Instructions shared by every reviewer, appended to each role brief. */
const SHARED_RULES = `
You are reviewing a prediction that has already been produced by a statistical
model and a Monte Carlo simulation. You are the reviewer, not the source of truth.

Rules:
- Do NOT recompute or second-guess the probabilities, expected runs, or EV. Those
  numbers stand. Your job is to judge whether they should be *trusted*.
- You can only lower confidence, never raise it. confidenceDelta is the number of
  ranks to drop: 0 = no change, 1 = one rank down, up to 3.
- Use "endorse" with confidenceDelta 0 when you find nothing wrong. Endorsing is
  the correct answer for a clean pick — do not invent concerns to seem useful.
- Use "reject" only when acting on this pick would be a mistake, not merely
  imperfect.
- Warnings must be specific and short enough to print on a report card. Cite the
  actual value that concerns you. No generic hedging.
`.trim();

/** Per-agent role brief. Kept out of the cached prefix — see the file header. */
const ROLE_BRIEFS: Record<ReviewAgent, string> = {
  "data-auditor": `
You are the DATA AUDITOR.

Your only concern is whether the inputs are present, current, and internally
consistent. You do not have an opinion about baseball.

Look for: missing or unconfirmed starters, stale timestamps, a neutral-fallback
ballpark, unconfirmed lineups, forecast weather standing in for observed, thin
recent-form samples, and any figure that contradicts another figure in the
dossier.

The validation layer has already flagged what it can detect mechanically. Your
value is in the gaps it cannot see — for example a starter ERA that looks
implausible for the innings pitched, or a park factor that does not match the
venue named. If the flags are all it found and they look complete, endorse.
`.trim(),

  "matchup-analyst": `
You are the MATCHUP ANALYST.

Judge whether the model's read of this specific matchup is reasonable in
baseball terms. You are checking the story the numbers tell, not the arithmetic.

Look for: a pitching matchup the model may be under- or over-weighting, injury
context that changes a lineup more than a blanket penalty suggests, weather and
park effects that compound in a way the linear adjustments miss, and bullpen
fatigue that will matter more in this specific game shape.

The model applies fixed multipliers and cannot know context. If the adjustments
land somewhere defensible for this matchup, endorse — a pick does not need to be
the one you would have made.
`.trim(),

  "risk-reviewer": `
You are the RISK REVIEWER.

Challenge over-confidence. You are the last line before a pick is presented as
actionable, and your bias should be toward caution.

Look for: an edge too large to be plausible against a sharp market, a
confidence rank that outruns the quality of the inputs behind it, thin evidence
carrying a strong recommendation, and correlated risks the confidence layer
treated as independent.

Remember the base rates: real edges against a sharp book are small, and a 60%
pick loses four times in ten. A pick being *reasonable* is not the same as it
being worth an S or A rank.

Do not stack a penalty for something the statistical layer already penalised —
its reasoning is in the dossier. Penalise what it missed.
`.trim(),
};

export function roleBrief(agent: ReviewAgent): string {
  return `${ROLE_BRIEFS[agent]}\n\n${SHARED_RULES}`;
}

/** The task turn. Short by design — the dossier is in the system prompt. */
export function reviewTask(agent: ReviewAgent): string {
  return (
    `Review the game above as the ${agent}. Return your verdict as JSON matching ` +
    `the required schema, with "agent" set to "${agent}".`
  );
}
