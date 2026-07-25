import { test } from "node:test";
import assert from "node:assert/strict";
import { assignConfidence, explainConfidence, rankGames, type ConfidenceInputs } from "./confidence";
import { computeBaseline } from "./model/baseline";
import { simulateGame } from "./model/simulate";
import { evaluateOdds } from "./odds/ev";
import { validateGame } from "./validate";
import { decimalToAmerican } from "./odds/conversion";
import { lowerRank } from "./flags";
import { neutralGame, REF_NOW } from "./test-fixtures";
import type { ConfidenceRank, GameOdds } from "./schemas";

const LABELS = { home: "Astros", away: "Angels" };

interface BuildOptions {
  homeRpg?: number;
  awayRpg?: number;
  odds?: Partial<GameOdds>;
  iterations?: number;
  totalLine?: number | null;
  /**
   * Price every market at the model's own probabilities (plus a little vig),
   * so the de-vigged market matches the model exactly and no edge exists.
   * This is what "the market agrees with us" looks like.
   */
  fairOdds?: boolean;
  /** Mutate the game/context before the pipeline runs. */
  mutate?: (g: ReturnType<typeof neutralGame>) => void;
}

/** An American price embedding probability `p` plus a small book margin. */
function priceAt(probability: number, vig = 1.02): number {
  return decimalToAmerican(1 / Math.min(0.98, probability * vig));
}

/** Run Steps 3-6 end to end so Step 7 sees genuine upstream output. */
function build(options: BuildOptions = {}): ConfidenceInputs {
  const fixture = neutralGame();
  const { game, context } = fixture;
  if (options.homeRpg !== undefined) game.homeBatting!.runsPerGame = options.homeRpg;
  if (options.awayRpg !== undefined) game.awayBatting!.runsPerGame = options.awayRpg;
  options.mutate?.(fixture);

  const totalLine = options.totalLine === undefined ? 8.5 : options.totalLine;

  const validation = validateGame(game, context, { asOf: REF_NOW });
  const baseline = computeBaseline(game, context);
  const simulation = simulateGame(baseline, {
    iterations: options.iterations ?? 20_000,
    totalLine,
  });

  const sim = simulation;
  const odds: GameOdds = options.fairOdds
    ? {
        gameId: "g-1",
        sportsbook: "TestBook",
        moneyline: { home: priceAt(sim.moneyline.home), away: priceAt(sim.moneyline.away) },
        runLine: {
          line: 1.5,
          homePrice: priceAt(sim.runLine.homeCoversMinus),
          awayPrice: priceAt(sim.runLine.awayCoversPlus),
        },
        total:
          totalLine === null
            ? null
            : {
                line: totalLine,
                overPrice: priceAt(sim.total.over!),
                underPrice: priceAt(sim.total.under!),
              },
        fetchedAt: REF_NOW,
        ...options.odds,
      }
    : {
        gameId: "g-1",
        sportsbook: "TestBook",
        moneyline: { home: -110, away: -110 },
        runLine: { line: 1.5, homePrice: 130, awayPrice: -150 },
        total: totalLine === null ? null : { line: totalLine, overPrice: -110, underPrice: -110 },
        fetchedAt: REF_NOW,
        ...options.odds,
      };

  const evaluation = evaluateOdds(simulation, odds, LABELS);
  return { validation, baseline, simulation, evaluation };
}

/* --- the core three inputs ------------------------------------------------ */

test("a big clean edge with good data earns a high rank", () => {
  const a = assignConfidence(build({ homeRpg: 5.8, awayRpg: 3.8 }));
  assert.ok(a.primaryBet !== null);
  assert.ok(["S", "A"].includes(a.rank), `rank was ${a.rank}`);
  assert.equal(a.dataCap, "S");
});

test("no edge means C, regardless of how clean the data is", () => {
  // The market is priced at the model's own numbers, so there is nothing to bet.
  const a = assignConfidence(build({ fairOdds: true }));
  assert.equal(a.primaryBet, null);
  assert.equal(a.rank, "C");
  assert.equal(a.dataCap, "S", "data was clean; the C comes from having no edge");
  assert.ok(a.factors.some((f) => f.label === "Edge size"));
});

test("a mispriced market on an even game still produces a real edge", () => {
  // Sanity check on the fixture itself: the -110/-150 book prices are wrong
  // for an evenly matched game, and the model should say so.
  const a = assignConfidence(build());
  assert.ok(a.primaryBet !== null, "a mispriced line is a genuine opportunity");
  assert.ok(a.primaryBet!.edge > 0.02);
});

test("a larger edge outranks a smaller one", () => {
  const small = assignConfidence(build({ homeRpg: 4.9, awayRpg: 4.2 }));
  const large = assignConfidence(build({ homeRpg: 5.8, awayRpg: 3.8 }));
  const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };
  assert.ok(order[large.rank] <= order[small.rank]);
  assert.ok(large.primaryBet!.edge > small.primaryBet!.edge);
});

/* --- (b) data quality is a ceiling ---------------------------------------- */

test("poor data caps the rank even when the edge is large", () => {
  const inputs = build({
    homeRpg: 5.8,
    awayRpg: 3.8,
    mutate: ({ game }) => {
      game.awayStarter = null; // error-level flag -> cap C
    },
  });
  const a = assignConfidence(inputs);
  assert.equal(a.dataCap, "C");
  assert.equal(a.rank, "C");
  assert.ok(
    a.factors.some((f) => f.label === "Data quality" && f.impact === "penalty"),
    "the cap should be recorded as a factor",
  );
});

test("a moderate data cap lowers but does not floor the rank", () => {
  const inputs = build({
    homeRpg: 5.8,
    awayRpg: 3.8,
    mutate: ({ game }) => {
      game.homeStarter!.confirmed = false; // warn -> cap A
    },
  });
  const a = assignConfidence(inputs);
  assert.equal(a.dataCap, "A");
  assert.equal(a.rank, "A");
});

test("clean data never promotes a weak edge", () => {
  const a = assignConfidence(build({ homeRpg: 4.75, awayRpg: 4.4 }));
  assert.equal(a.dataCap, "S");
  assert.ok(a.rank !== "S", "a small edge must not reach S just because data is clean");
});

/* --- (c) component agreement ---------------------------------------------- */

test("an implausibly large edge is penalised, not celebrated", () => {
  // Price a hugely mismatched game at even money to manufacture a giant edge.
  const a = assignConfidence(build({ homeRpg: 8.0, awayRpg: 2.5 }));
  assert.ok(a.primaryBet!.edge >= 0.15, `edge was ${a.primaryBet!.edge}`);
  const factor = a.factors.find((f) => f.label === "Implausible edge");
  assert.ok(factor, "expected an implausible-edge penalty");
  assert.equal(factor!.impact, "penalty");
  assert.ok(a.rankBeforeCap !== a.baseRank, "the penalty must actually move the rank");
});

test("an edge smaller than simulation noise is penalised", () => {
  // Few iterations -> large standard error.
  const a = assignConfidence(build({ homeRpg: 5.0, awayRpg: 4.2, iterations: 200 }));
  const factor = a.factors.find((f) => f.label === "Simulation noise");
  assert.ok(factor);
  assert.equal(factor!.impact, "penalty");
});

test("a well-resolved simulation records noise as supporting", () => {
  const a = assignConfidence(build({ homeRpg: 5.8, awayRpg: 3.8, iterations: 20_000 }));
  const factor = a.factors.find((f) => f.label === "Simulation noise");
  assert.ok(factor);
  assert.equal(factor!.impact, "supports");
});

test("recent form running against the pick is a penalty", () => {
  const inputs = build({
    homeRpg: 5.8,
    awayRpg: 3.8,
    mutate: ({ context }) => {
      // The home team is the pick; give it a cold streak.
      context.recentForm.home.runsScoredPerGame = 2.0;
    },
  });
  const a = assignConfidence(inputs);
  const factor = a.factors.find((f) => f.label === "Recent form");
  assert.ok(factor);
  assert.equal(factor!.impact, "penalty");
});

test("a trivial form wobble is neutral, not a penalty", () => {
  const inputs = build({
    homeRpg: 5.8,
    awayRpg: 3.8,
    mutate: ({ context }) => {
      // Recent form a hair below the season rate — noise, not disagreement.
      context.recentForm.home.runsScoredPerGame = 5.75;
    },
  });
  const a = assignConfidence(inputs);
  const factor = a.factors.find((f) => f.label === "Recent form");
  assert.ok(factor);
  assert.equal(factor!.impact, "neutral", `detail was: ${factor!.detail}`);
  assert.equal(factor!.steps, 0);
});

test("recent form backing the pick is recorded as supporting", () => {
  const inputs = build({
    homeRpg: 5.8,
    awayRpg: 3.8,
    mutate: ({ context }) => {
      context.recentForm.home.runsScoredPerGame = 7.0; // hot streak
    },
  });
  const a = assignConfidence(inputs);
  const factor = a.factors.find((f) => f.label === "Recent form");
  assert.ok(factor);
  assert.equal(factor!.impact, "supports");
});

test("a totals pick built on forecast weather is penalised", () => {
  const inputs = build({
    totalLine: 7.5, // a low line the model should want to bet OVER
    odds: {
      moneyline: null,
      runLine: null,
      total: { line: 7.5, overPrice: -110, underPrice: -110 },
    },
    mutate: ({ game, context }) => {
      context.weather = {
        ...context.weather,
        weatherMode: "forecast",
        forecastFor: game.startTime,
        temperatureF: 92,
        windSpeedMph: 14,
        windRelative: "out",
      };
    },
  });
  const a = assignConfidence(inputs);
  assert.equal(a.primaryBet?.market, "total");
  const factor = a.factors.find((f) => f.label === "Forecast weather");
  assert.ok(factor, "a forecast-driven total should be flagged");
  assert.equal(factor!.impact, "penalty");
});

test("an observed-weather total carries no forecast penalty", () => {
  const inputs = build({
    totalLine: 7.5,
    odds: {
      moneyline: null,
      runLine: null,
      total: { line: 7.5, overPrice: -110, underPrice: -110 },
    },
    mutate: ({ context }) => {
      context.weather = {
        ...context.weather,
        weatherMode: "observed",
        forecastFor: null,
        temperatureF: 92,
        windSpeedMph: 14,
        windRelative: "out",
      };
    },
  });
  const a = assignConfidence(inputs);
  assert.equal(a.primaryBet?.market, "total");
  assert.ok(!a.factors.some((f) => f.label === "Forecast weather"));
});

/* --- bookkeeping and reporting -------------------------------------------- */

test("the assessment records each stage of the rank derivation", () => {
  const a = assignConfidence(build({ homeRpg: 5.8, awayRpg: 3.8 }));
  const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };
  assert.ok(order[a.baseRank] <= order[a.rankBeforeCap], "penalties only lower");
  assert.ok(order[a.rankBeforeCap] <= order[a.rank], "the cap only lowers");
  assert.equal(a.gameId, "g-1");
});

test("penalties stack and are clamped at C", () => {
  // Direct check of the clamp: no number of penalties can go below C.
  assert.equal(lowerRank("S", 3), "C");
  assert.equal(lowerRank("S", 99), "C");
  assert.equal(lowerRank("B", 5), "C");
});

test("multiple penalties compound on the same pick", () => {
  const a = assignConfidence(
    build({
      homeRpg: 8.0, // an implausibly large edge
      awayRpg: 2.5,
      mutate: ({ context }) => {
        context.recentForm.home.runsScoredPerGame = 1.5; // form contradicts it
      },
    }),
  );
  assert.equal(a.baseRank, "S");
  const penalties = a.factors.filter((f) => f.impact === "penalty");
  assert.ok(penalties.length >= 2, "both the edge and form penalties should fire");
  const totalSteps = penalties.reduce((sum, f) => sum + f.steps, 0);
  assert.equal(a.rankBeforeCap, lowerRank("S", totalSteps));
  assert.equal(a.rankBeforeCap, "B");
});

test("rankGames sorts best rank first, then by edge", () => {
  const ranked = rankGames([
    build({ fairOdds: true }), // no edge -> C
    build({ homeRpg: 5.8, awayRpg: 3.8 }), // strong edge
    build({ homeRpg: 4.9, awayRpg: 4.2 }), // modest edge
  ]);
  const order: Record<ConfidenceRank, number> = { S: 0, A: 1, B: 2, C: 3 };
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(order[ranked[i - 1].rank] <= order[ranked[i].rank]);
  }
  assert.equal(ranked[ranked.length - 1].rank, "C");
});

test("explainConfidence renders a header plus one line per factor", () => {
  const a = assignConfidence(build({ homeRpg: 5.8, awayRpg: 3.8 }));
  const lines = explainConfidence(a);
  assert.equal(lines.length, a.factors.length + 1);
  assert.match(lines[0], /^Confidence: [SABC]/);
  assert.ok(lines.some((l) => l.includes("Edge size")));
});

test("explainConfidence says so plainly when there is no bet", () => {
  const lines = explainConfidence(assignConfidence(build({ fairOdds: true })));
  assert.match(lines[0], /no recommended bet/);
});

test("a game with no priced markets still ranks without crashing", () => {
  const inputs = build({
    totalLine: null,
    odds: { moneyline: null, runLine: null, total: null },
  });
  const a = assignConfidence(inputs);
  assert.equal(a.rank, "C");
  assert.equal(a.primaryBet, null);
  assert.ok(a.factors[0].detail.includes("No markets"));
});
