import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReview,
  explainReview,
  reviewGame,
  REVIEW_AGENTS,
  type ReviewOptions,
} from "./review";
import { buildDossier, type DossierInputs } from "./prompts";
import { ruleBasedReviewer, type Reviewer } from "./reviewers";
import { reviewVerdictSchema, type ReviewAgent, type ReviewVerdict } from "./schemas";
import { assignConfidence } from "../confidence";
import { computeBaseline } from "../model/baseline";
import { simulateGame } from "../model/simulate";
import { evaluateOdds } from "../odds/ev";
import { validateGame } from "../validate";
import { neutralGame, REF_NOW } from "../test-fixtures";
import type { ConfidenceRank, GameOdds } from "../schemas";

const LABELS = { home: "Astros", away: "Angels" };

/** Build genuine Steps 3–7 output so the review sees a real dossier. */
function buildInputs(mutate?: (f: ReturnType<typeof neutralGame>) => void): DossierInputs {
  const fixture = neutralGame();
  const { game, context } = fixture;
  // A lopsided game against a flat market, so a value bet exists to review.
  game.homeBatting!.runsPerGame = 5.8;
  game.awayBatting!.runsPerGame = 3.8;
  mutate?.(fixture);

  const odds: GameOdds = {
    gameId: game.gameId,
    sportsbook: "TestBook",
    moneyline: { home: -110, away: -110 },
    runLine: { line: 1.5, homePrice: 130, awayPrice: -150 },
    total: { line: 8.5, overPrice: -110, underPrice: -110 },
    fetchedAt: REF_NOW,
  };

  const validation = validateGame(game, context, { asOf: REF_NOW });
  const baseline = computeBaseline(game, context);
  const simulation = simulateGame(baseline, { iterations: 20_000, totalLine: 8.5 });
  const evaluation = evaluateOdds(simulation, odds, LABELS);
  const confidence = assignConfidence({ validation, baseline, simulation, evaluation });

  return { game, context, validation, baseline, simulation, evaluation, confidence };
}

function verdict(agent: ReviewAgent, over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    agent,
    assessment: "endorse",
    confidenceDelta: 0,
    warnings: [],
    reasoning: "test",
    ...over,
  };
}

/** A reviewer that always returns the given verdict shape. */
function stubReviewer(make: (agent: ReviewAgent) => ReviewVerdict): Reviewer {
  return async (agent) => make(agent);
}

const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };

/* --- the core constraint: review can only lower ---------------------------- */

test("a clean review leaves the rank untouched", () => {
  const r = applyReview("A", [verdict("data-auditor"), verdict("risk-reviewer")]);
  assert.equal(r.rank, "A");
  assert.equal(r.confidenceDelta, 0);
  assert.equal(r.rejected, false);
});

test("deltas from different agents compound", () => {
  const r = applyReview("S", [
    verdict("data-auditor", { assessment: "caution", confidenceDelta: 1 }),
    verdict("matchup-analyst", { assessment: "caution", confidenceDelta: 1 }),
  ]);
  assert.equal(r.rank, "B");
  assert.equal(r.confidenceDelta, 2, "positive means ranks dropped, matching the verdict field");
});

test("a single reject floors the rank at C", () => {
  const r = applyReview("S", [
    verdict("data-auditor"),
    verdict("risk-reviewer", { assessment: "reject", confidenceDelta: 1 }),
  ]);
  assert.equal(r.rank, "C");
  assert.equal(r.rejected, true);
});

test("a negative delta cannot promote a pick", () => {
  // The schema forbids this; a hand-built verdict could still carry it.
  const r = applyReview("B", [verdict("risk-reviewer", { confidenceDelta: -3 as number })]);
  assert.equal(r.rank, "B", "a negative delta must be clamped, never applied");
  assert.equal(r.confidenceDelta, 0);
});

test("the schema itself refuses to represent a promotion", () => {
  const parsed = reviewVerdictSchema.safeParse({
    agent: "risk-reviewer",
    assessment: "endorse",
    confidenceDelta: -1,
    warnings: [],
    reasoning: "trying to promote",
  });
  assert.equal(parsed.success, false, "a negative confidenceDelta must not validate");
});

test("review output carries no field that could change a probability", () => {
  // Structural guarantee: the outcome exposes a rank and warnings only.
  const r = applyReview("A", [verdict("data-auditor")]);
  assert.deepEqual(Object.keys(r).sort(), ["confidenceDelta", "rank", "rejected", "warnings"]);
});

test("deltas never push past C", () => {
  const r = applyReview("B", [
    verdict("data-auditor", { confidenceDelta: 3 }),
    verdict("matchup-analyst", { confidenceDelta: 3 }),
  ]);
  assert.equal(r.rank, "C");
});

test("warnings from every reviewer are merged and deduplicated", () => {
  const r = applyReview("A", [
    verdict("data-auditor", { warnings: ["same warning", "auditor only"] }),
    verdict("risk-reviewer", { warnings: ["same warning"] }),
  ]);
  assert.deepEqual(r.warnings.sort(), ["auditor only", "same warning"]);
});

/* --- orchestration --------------------------------------------------------- */

test("all three agents run and their verdicts are returned", async () => {
  const outcome = await reviewGame(buildInputs(), { reviewer: stubReviewer((a) => verdict(a)) });
  assert.equal(outcome.reviewed, true);
  assert.equal(outcome.verdicts.length, 3);
  assert.deepEqual(
    outcome.verdicts.map((v) => v.agent).sort(),
    [...REVIEW_AGENTS].sort(),
  );
});

test("a game with no recommended bet is skipped, not reviewed", async () => {
  const inputs = buildInputs();
  // Strip the value bets so the confidence layer reports nothing to act on.
  const confidence = { ...inputs.confidence, primaryBet: null };
  const outcome = await reviewGame({ ...inputs, confidence });

  assert.equal(outcome.reviewed, false);
  assert.match(outcome.skippedReason ?? "", /nothing to review/i);
  assert.equal(outcome.rank, outcome.rankBefore, "a skipped review must not move the rank");
  assert.equal(outcome.verdicts.length, 0);
});

test("skipping can be overridden for pipeline audits", async () => {
  const inputs = buildInputs();
  const confidence = { ...inputs.confidence, primaryBet: null };
  const outcome = await reviewGame(
    { ...inputs, confidence },
    { reviewGamesWithoutBets: true, reviewer: stubReviewer((a) => verdict(a)) },
  );
  assert.equal(outcome.reviewed, true);
  assert.equal(outcome.skippedReason, null);
});

test("one failing reviewer degrades the review instead of deleting it", async () => {
  const flaky: Reviewer = async (agent) => {
    if (agent === "matchup-analyst") throw new Error("upstream exploded");
    return verdict(agent, { assessment: "caution", confidenceDelta: 1 });
  };
  const outcome = await reviewGame(buildInputs(), { reviewer: flaky });

  assert.equal(outcome.verdicts.length, 2, "the other two verdicts still count");
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0].agent, "matchup-analyst");
  assert.ok(outcome.warnings.some((w) => /Review incomplete/.test(w)));
  // Two cautions applied; the failure itself changed nothing.
  assert.equal(outcome.rank, "C");
});

test("a failed reviewer does not by itself lower the rank", async () => {
  const allFail: Reviewer = async () => {
    throw new Error("no network");
  };
  const outcome = await reviewGame(buildInputs(), { reviewer: allFail });

  assert.equal(outcome.reviewed, false, "no verdicts means the review did not happen");
  assert.equal(outcome.rank, outcome.rankBefore, "an absent opinion is not evidence against a pick");
  assert.equal(outcome.failures.length, 3);
});

test("running a subset of agents is supported", async () => {
  const outcome = await reviewGame(buildInputs(), {
    agents: ["risk-reviewer"],
    reviewer: stubReviewer((a) => verdict(a)),
  });
  assert.equal(outcome.verdicts.length, 1);
  assert.equal(outcome.verdicts[0].agent, "risk-reviewer");
});

test("the reviewed rank is never better than the statistical rank", async () => {
  const promoter = stubReviewer((a) => verdict(a, { confidenceDelta: -2 as number }));
  const inputs = buildInputs();
  const outcome = await reviewGame(inputs, { reviewer: promoter });
  assert.ok(order[outcome.rank] >= order[outcome.rankBefore]);
});

/* --- the deterministic reviewer -------------------------------------------- */

test("the rule-based reviewer endorses a clean game", async () => {
  const outcome = await reviewGame(buildInputs(), { reviewer: ruleBasedReviewer });
  assert.equal(outcome.reviewed, true);
  assert.ok(outcome.verdicts.every((v) => v.assessment === "endorse"));
  assert.equal(outcome.rank, outcome.rankBefore);
});

test("the rule-based auditor catches a missing starter", async () => {
  const inputs = buildInputs(({ game }) => {
    game.awayStarter = null;
  });
  const outcome = await reviewGame(inputs, {
    reviewer: ruleBasedReviewer,
    reviewGamesWithoutBets: true,
  });
  const auditor = outcome.verdicts.find((v) => v.agent === "data-auditor")!;
  assert.equal(auditor.assessment, "reject");
  assert.ok(auditor.warnings.some((w) => /not named/i.test(w)));
});

test("the rule-based auditor catches a neutral-fallback ballpark", async () => {
  const inputs = buildInputs(({ context }) => {
    context.ballpark.isNeutralFallback = true;
  });
  const outcome = await reviewGame(inputs, { reviewer: ruleBasedReviewer });
  const auditor = outcome.verdicts.find((v) => v.agent === "data-auditor")!;
  assert.ok(auditor.warnings.some((w) => /neutral/i.test(w)));
  assert.ok(auditor.confidenceDelta > 0);
});

test("the rule-based risk reviewer notes forecast weather", async () => {
  const inputs = buildInputs(({ game, context }) => {
    context.weather = {
      ...context.weather,
      weatherMode: "forecast",
      forecastFor: game.startTime,
    };
  });
  const outcome = await reviewGame(inputs, { reviewer: ruleBasedReviewer });
  const risk = outcome.verdicts.find((v) => v.agent === "risk-reviewer")!;
  assert.ok(risk.warnings.some((w) => /forecast/i.test(w)));
});

test("every rule-based verdict satisfies the schema", async () => {
  for (const agent of REVIEW_AGENTS) {
    const v = await ruleBasedReviewer(agent, buildDossier(buildInputs()));
    assert.equal(reviewVerdictSchema.safeParse(v).success, true, `${agent} produced an invalid verdict`);
  }
});

/* --- the dossier ----------------------------------------------------------- */

test("the dossier carries every stage the reviewers need", () => {
  const dossier = buildDossier(buildInputs());
  for (const section of [
    "GAME:",
    "STARTERS",
    "CONTEXT",
    "DATA VALIDATION",
    "BASELINE MODEL",
    "SIMULATION",
    "MARKET AND EXPECTED VALUE",
    "CONFIDENCE",
  ]) {
    assert.ok(dossier.includes(section), `dossier is missing the ${section} section`);
  }
});

test("the dossier states the weather mode explicitly", () => {
  const observed = buildDossier(buildInputs());
  assert.match(observed, /Weather: OBSERVED/);

  const forecast = buildDossier(
    buildInputs(({ game, context }) => {
      context.weather = { ...context.weather, weatherMode: "forecast", forecastFor: game.startTime };
    }),
  );
  assert.match(forecast, /Weather: FORECAST/);
});

test("the dossier is identical across agents, so it can be cached once", () => {
  const inputs = buildInputs();
  assert.equal(buildDossier(inputs), buildDossier(inputs));
});

/* --- reporting ------------------------------------------------------------- */

test("explainReview reports a confirmed rank", async () => {
  const outcome = await reviewGame(buildInputs(), { reviewer: stubReviewer((a) => verdict(a)) });
  const lines = explainReview(outcome);
  assert.match(lines[0], /confirmed/);
  assert.equal(lines.length, 1 + outcome.verdicts.length);
});

test("explainReview reports a downgrade and marks a rejection", async () => {
  const outcome = await reviewGame(buildInputs(), {
    reviewer: stubReviewer((a) =>
      verdict(a, { assessment: "reject", confidenceDelta: 1, warnings: ["bad data"] }),
    ),
  });
  const text = explainReview(outcome).join("\n");
  assert.match(text, /→ C/);
  assert.match(text, /REJECTED/);
  assert.match(text, /bad data/);
});

test("explainReview says plainly when the review was skipped", async () => {
  const inputs = buildInputs();
  const outcome = await reviewGame({ ...inputs, confidence: { ...inputs.confidence, primaryBet: null } });
  assert.match(explainReview(outcome)[0], /skipped/);
});
