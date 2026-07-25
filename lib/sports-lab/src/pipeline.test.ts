import { test } from "node:test";
import assert from "node:assert/strict";
import { runDailyPipeline, seedForGame, type SlateEntry } from "./pipeline";
import { finalRank, keyFactors, renderDailySummary, renderGameCard, serializeDailyLog, sortByConfidence, toDailyLog } from "./report";
import { neutralGame, REF_NOW } from "./test-fixtures";
import type { GameOdds, ConfidenceRank } from "./schemas";
import type { Reviewer } from "./review/reviewers";

const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };

/** One slate entry, optionally mutated and optionally mispriced into an edge. */
function entry(
  gameId: string,
  opts: {
    homeRpg?: number;
    awayRpg?: number;
    odds?: GameOdds | null;
    mutate?: (f: ReturnType<typeof neutralGame>) => void;
  } = {},
): SlateEntry {
  const fixture = neutralGame();
  const { game, context } = fixture;
  game.gameId = gameId;
  if (opts.homeRpg !== undefined) game.homeBatting!.runsPerGame = opts.homeRpg;
  if (opts.awayRpg !== undefined) game.awayBatting!.runsPerGame = opts.awayRpg;
  opts.mutate?.(fixture);

  const odds: GameOdds | null =
    opts.odds === undefined
      ? {
          gameId,
          sportsbook: "TestBook",
          moneyline: { home: -110, away: -110 },
          runLine: { line: 1.5, homePrice: 130, awayPrice: -150 },
          total: { line: 8.5, overPrice: -110, underPrice: -110 },
          fetchedAt: REF_NOW,
        }
      : opts.odds;

  return { game, context, odds };
}

const RUN = { asOf: REF_NOW, iterations: 4000 } as const;

/* --- orchestration --------------------------------------------------------- */

test("a slate produces one prediction per game", async () => {
  const result = await runDailyPipeline(
    [entry("g1"), entry("g2", { homeRpg: 5.8, awayRpg: 3.8 }), entry("g3")],
    RUN,
  );
  assert.equal(result.predictions.length, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.log.gameCount, 3);
});

test("one unmodelable game does not take down the slate", async () => {
  const broken = entry("broken", {
    mutate: ({ game }) => {
      game.homeBatting = null; // no offense anchor → BaselineInputError
    },
  });
  const result = await runDailyPipeline([entry("ok1"), broken, entry("ok2")], RUN);

  assert.equal(result.predictions.length, 2, "the healthy games still predict");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].gameId, "broken");
  assert.equal(result.failures[0].stage, "baseline");
  assert.match(result.failures[0].message, /homeBatting\.runsPerGame/);
});

test("un-predictable games are printed, not just returned", async () => {
  const broken = entry("broken", {
    mutate: ({ game }) => {
      game.awayBatting = null;
    },
  });
  const result = await runDailyPipeline([entry("ok"), broken], RUN);
  assert.match(result.report, /GAMES WITH NO PREDICTION \(1\)/);
  assert.match(result.report, /broken — failed at baseline/);
});

test("a game with no posted odds still predicts, with no bets", async () => {
  const result = await runDailyPipeline([entry("g1", { odds: null })], RUN);
  assert.equal(result.predictions.length, 1);
  const p = result.predictions[0];
  assert.equal(p.evaluation.bets.length, 0);
  assert.deepEqual(p.evaluation.skippedMarkets, ["moneyline", "run_line", "total"]);
  assert.equal(p.confidence.primaryBet, null);
});

/* --- reproducibility ------------------------------------------------------- */

test("the same slate re-run produces identical probabilities", async () => {
  const slate = [entry("g1", { homeRpg: 5.5 }), entry("g2")];
  const a = await runDailyPipeline(slate, RUN);
  const b = await runDailyPipeline(slate, RUN);
  assert.deepEqual(
    a.predictions.map((p) => p.simulation.moneyline.home),
    b.predictions.map((p) => p.simulation.moneyline.home),
  );
});

test("different games in one slate get different seeds", async () => {
  const result = await runDailyPipeline([entry("g1"), entry("g2"), entry("g3")], RUN);
  const seeds = result.predictions.map((p) => p.simulation.seed);
  assert.equal(new Set(seeds).size, 3, "seeds must not collide within a slate");
});

test("seedForGame is stable and id-dependent", () => {
  assert.equal(seedForGame("game-a"), seedForGame("game-a"));
  assert.notEqual(seedForGame("game-a"), seedForGame("game-b"));
  assert.notEqual(seedForGame("game-a"), seedForGame("game-a", 7), "seedBase must vary the stream");
  assert.ok(Number.isInteger(seedForGame("game-a")) && seedForGame("game-a") >= 0);
});

/* --- run modes ------------------------------------------------------------- */

test("the pregame refresh applies a tighter staleness bar than the morning run", async () => {
  // Data fetched 8 hours before the run: fine in the morning, stale by pregame.
  const eightHoursEarlier = "2026-07-25T04:00:00Z";
  const make = () =>
    entry("g1", {
      mutate: ({ context }) => {
        context.weather.fetchedAt = eightHoursEarlier;
        context.injuries.home.fetchedAt = eightHoursEarlier;
      },
    });

  const morning = await runDailyPipeline([make()], { ...RUN, runMode: "morning" });
  const pregame = await runDailyPipeline([make()], { ...RUN, runMode: "pregame" });

  const staleIn = (r: typeof morning) =>
    r.predictions[0].validation.flags.filter((f) => f.code === "stale_data").length;

  assert.equal(staleIn(morning), 0, "8h-old data is acceptable on the morning run");
  assert.ok(staleIn(pregame) > 0, "the same data should be flagged stale at pregame");
});

test("the run mode is recorded on the report and the log", async () => {
  const result = await runDailyPipeline([entry("g1")], { ...RUN, runMode: "pregame" });
  assert.equal(result.meta.runMode, "pregame");
  assert.equal(result.log.runMode, "pregame");
  assert.match(result.report, /pregame run/);
});

/* --- the review inside the pipeline ---------------------------------------- */

test("the review runs by default and its rank is what the report shows", async () => {
  const downgrade: Reviewer = async (agent) => ({
    agent,
    assessment: "caution",
    confidenceDelta: 1,
    warnings: ["reviewer downgrade"],
    reasoning: "test",
  });
  const result = await runDailyPipeline([entry("g1", { homeRpg: 5.8, awayRpg: 3.8 })], {
    ...RUN,
    reviewer: downgrade,
  });
  const p = result.predictions[0];
  assert.ok(p.review !== null && p.review.reviewed);
  assert.ok(order[finalRank(p)] > order[p.confidence.rank], "the review must have lowered it");
  assert.match(result.report, /AI review/);
});

test("the review can be turned off", async () => {
  const result = await runDailyPipeline([entry("g1")], { ...RUN, runReview: false });
  assert.equal(result.predictions[0].review, null);
  assert.equal(finalRank(result.predictions[0]), result.predictions[0].confidence.rank);
});

test("a rejected pick is kept out of Best Bets however strong its edge", async () => {
  const rejector: Reviewer = async (agent) => ({
    agent,
    assessment: "reject",
    confidenceDelta: 0,
    warnings: ["data cannot be trusted"],
    reasoning: "test",
  });
  const result = await runDailyPipeline([entry("g1", { homeRpg: 6.5, awayRpg: 3.5 })], {
    ...RUN,
    reviewer: rejector,
  });
  const summary = renderDailySummary(result.predictions).join("\n");
  assert.match(summary, /None today/);
  assert.equal(result.log.games[0].reviewRejected, true);
});

/* --- report rendering ------------------------------------------------------ */

test("a game card carries every section from the plan's layout", async () => {
  const result = await runDailyPipeline([entry("g1", { homeRpg: 5.8, awayRpg: 3.8 })], RUN);
  const card = renderGameCard(result.predictions[0]).join("\n");
  for (const section of ["Confidence:", "Moneyline:", "Run line:", "Total:", "Value:", "Key factors:", "Flags:"]) {
    assert.ok(card.includes(section), `card is missing "${section}"`);
  }
  assert.match(card, /→ Pick:/);
});

test("the run-line note describes likelihood, not value", async () => {
  // A market can be genuinely mispriced on the side less likely to cover, so
  // the run-line line must not claim there is "no edge" — that is the Value
  // block's call, and the two would contradict each other.
  const result = await runDailyPipeline([entry("g1")], RUN);
  const card = renderGameCard(result.predictions[0]).join("\n");
  const runLine = card.split("\n").find((l) => l.startsWith("Run line:"))!;
  assert.ok(
    /→ (Likely:|Neither side favored to cover)/.test(runLine),
    `run-line note should be about likelihood, got: ${runLine}`,
  );
  assert.ok(!/no strong edge/i.test(runLine));
});

test("games are sorted best rank first", async () => {
  const result = await runDailyPipeline(
    [entry("weak"), entry("strong", { homeRpg: 6.2, awayRpg: 3.4 })],
    RUN,
  );
  const sorted = sortByConfidence(result.predictions);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(order[finalRank(sorted[i - 1])] <= order[finalRank(sorted[i])]);
  }
});

test("keyFactors reports the adjustments that actually moved the game", async () => {
  const result = await runDailyPipeline([entry("g1", { homeRpg: 6.2, awayRpg: 3.4 })], RUN);
  const factors = keyFactors(result.predictions[0]);
  assert.ok(factors.length > 0);
  assert.ok(factors.length <= 3);
  assert.ok(factors.some((f) => /r\/g vs league/.test(f)), "the offense gap should be a key factor");
});

test("the summary lists data issues and downgrades", async () => {
  const result = await runDailyPipeline(
    [entry("g1", { mutate: ({ game }) => { game.homeStarter!.confirmed = false; } })],
    RUN,
  );
  const summary = renderDailySummary(result.predictions).join("\n");
  assert.match(summary, /DATA ISSUES AND DOWNGRADES/);
  assert.match(summary, /unconfirmed_starter/);
});

test("a clean slate says so rather than printing an empty section", async () => {
  const result = await runDailyPipeline([entry("g1")], { ...RUN, runReview: false });
  const summary = renderDailySummary(result.predictions).join("\n");
  assert.match(summary, /None\. Every game had complete, current data/);
});

test("the report carries the variance disclaimer", async () => {
  const result = await runDailyPipeline([entry("g1")], RUN);
  assert.match(result.report, /Not financial advice/);
  assert.match(result.report, /60% pick loses four/);
});

/* --- the structured log ---------------------------------------------------- */

test("the log carries what a backtest needs to settle each game", async () => {
  const result = await runDailyPipeline([entry("g1", { homeRpg: 5.8, awayRpg: 3.8 })], RUN);
  const logged = result.log.games[0];

  assert.equal(logged.gameId, "g1");
  assert.ok(logged.record.bets.length > 0, "bets must be logged with their odds");
  assert.ok(logged.record.bets.every((b) => typeof b.decimalOdds === "number"));
  assert.equal(logged.sportsbook, "TestBook");
  assert.equal(logged.oddsFetchedAt, REF_NOW);
});

test("the log records the rank that was acted on, not the pre-review one", async () => {
  const downgrade: Reviewer = async (agent) => ({
    agent,
    assessment: "caution",
    confidenceDelta: 1,
    warnings: [],
    reasoning: "test",
  });
  const result = await runDailyPipeline([entry("g1", { homeRpg: 5.8, awayRpg: 3.8 })], {
    ...RUN,
    reviewer: downgrade,
  });
  const logged = result.log.games[0];
  assert.notEqual(logged.rank, logged.statisticalRank);
  assert.equal(logged.record.rank, logged.rank, "the backtest record must score what was recommended");
});

test("the log captures the seed and iteration count for reproduction", async () => {
  const result = await runDailyPipeline([entry("g1")], RUN);
  const logged = result.log.games[0];
  assert.equal(logged.simulationSeed, seedForGame("g1"));
  assert.equal(logged.simulationIterations, 4000);
});

test("the log records whether weather was observed or forecast", async () => {
  const forecast = await runDailyPipeline(
    [
      entry("g1", {
        mutate: ({ game, context }) => {
          context.weather = { ...context.weather, weatherMode: "forecast", forecastFor: game.startTime };
        },
      }),
    ],
    RUN,
  );
  assert.equal(forecast.log.games[0].weatherMode, "forecast");
});

test("the log round-trips through JSON", async () => {
  const result = await runDailyPipeline([entry("g1"), entry("g2", { homeRpg: 5.5 })], RUN);
  const parsed = JSON.parse(serializeDailyLog(result.log));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(result.log)));
  assert.equal(parsed.games.length, 2);
});

test("an empty slate produces a valid empty report and log", async () => {
  const result = await runDailyPipeline([], RUN);
  assert.equal(result.predictions.length, 0);
  assert.equal(result.log.gameCount, 0);
  assert.match(result.report, /None today/);
  assert.deepEqual(toDailyLog([], result.meta).games, []);
});
