/**
 * The daily workflow, Steps 1-7 wired together.
 *
 * collect -> validate -> baseline -> simulate -> calibrate -> EV -> confidence
 *
 * `predictDate` is deterministic given the same inputs and calibration: the
 * simulation seed is derived from the model version, the date and the game id.
 * Re-running the same day reproduces the same numbers, which is what makes a
 * disagreement between two runs a real signal rather than Monte Carlo noise.
 */

import { MLB_CONSTANTS, MODEL_VERSION, type ModelConstants, type RuntimeConfig } from "../config";
import { nowIso } from "../core/dates";
import type {
  Calibration,
  DailyPredictions,
  GameContext,
  GamePrediction,
  GameDate,
  Side,
} from "../core/types";
import { calibrateTotal, calibrateWinProbability } from "../loop/calibration";
import { runBaseline } from "./baseline";
import { Collector, createSources, type SourceBundle } from "./collect";
import { assessConfidence } from "./confidence";
import { evaluateGameBets } from "./ev";
import { defaultSimulationParams, seedForGame, simulateGame } from "./simulate";
import { assessDataQuality } from "./validate";

export interface PredictOptions {
  date: GameDate;
  config: RuntimeConfig;
  calibration: Calibration;
  constants?: ModelConstants;
  sources?: SourceBundle;
}

/** Short, readable reasons a game looks the way it does. */
function buildKeyFactors(
  context: GameContext,
  baseline: ReturnType<typeof runBaseline>,
): string[] {
  const factors: string[] = [];

  for (const side of ["home", "away"] as Side[]) {
    const starter = context.teams[side].starter;
    if (!starter || starter.era === null) continue;
    // Only mention a starter when they are clearly good or clearly bad.
    if (starter.era <= 3.3 || starter.era >= 4.8) {
      factors.push(
        `${context.teams[side].team.abbrev} ${starter.pitcher.fullName} ` +
          `${starter.era.toFixed(2)} ERA`,
      );
    }
  }

  if (context.park.matched && Math.abs(context.park.runs - 1) >= 0.03) {
    factors.push(
      `${context.park.venueName} plays ${context.park.runs > 1 ? "up" : "down"} ` +
        `(${((context.park.runs - 1) * 100).toFixed(0)}% runs)`,
    );
  }

  const weatherAdjustment = baseline.teams.home.adjustments.find((a) => a.name === "weather");
  if (weatherAdjustment && Math.abs(weatherAdjustment.multiplier - 1) >= 0.02) {
    factors.push(`weather ${weatherAdjustment.multiplier > 1 ? "helps" : "suppresses"} runs (${weatherAdjustment.note})`);
  }

  for (const side of ["home", "away"] as Side[]) {
    const injuries = context.teams[side].injuries;
    if (injuries && injuries.injuredListCount >= 5) {
      factors.push(
        `${context.teams[side].team.abbrev} has ${injuries.injuredListCount} players on the IL`,
      );
    }
    const bullpen = context.teams[side].bullpen;
    if (bullpen?.fatigueIndex != null && bullpen.fatigueIndex >= 0.5) {
      factors.push(`${context.teams[side].team.abbrev} bullpen is worked (recent heavy usage)`);
    }
  }

  return factors.slice(0, 5);
}

export function predictGame(
  context: GameContext,
  calibration: Calibration,
  config: RuntimeConfig,
  constants: ModelConstants = MLB_CONSTANTS,
): GamePrediction {
  const quality = assessDataQuality(context);
  const baseline = runBaseline(context, constants);

  const simulation = simulateGame(
    baseline,
    defaultSimulationParams({
      simulations: config.simulations,
      seed: seedForGame(context.gamePk, context.date, MODEL_VERSION),
      dispersionK: calibration.runDispersionK,
      targetExtraInningsRate: calibration.extraInningsRate,
      totalLine: context.odds?.total?.line ?? null,
      extraInnings: constants.extraInnings,
    }),
  );

  const homeWinProbability = calibrateWinProbability(
    simulation.winProbability.home,
    calibration,
  );
  const predictedTotal = calibrateTotal(simulation.meanTotal, calibration);

  const bets = evaluateGameBets({
    odds: context.odds,
    simulation,
    homeWinProbability,
    home: context.teams.home.team,
    away: context.teams.away.team,
    totalShift: predictedTotal - simulation.meanTotal,
    constants,
  });

  const confidence = assessConfidence({
    context,
    quality,
    simulation,
    bets,
    calibration,
    constants,
  });

  const pickSide: Side = homeWinProbability >= 0.5 ? "home" : "away";
  const away = context.teams.away.team;
  const home = context.teams.home.team;

  return {
    sport: context.sport,
    gamePk: context.gamePk,
    date: context.date,
    gameTimeUtc: context.gameTimeUtc,
    matchup: `${away.name} @ ${home.name}`,
    home,
    away,
    quality,
    baseline,
    simulation,
    calibrated: {
      homeWinProbability,
      awayWinProbability: 1 - homeWinProbability,
      predictedTotal,
      calibrationVersion: calibration.version,
    },
    moneylinePick: {
      side: pickSide,
      team: pickSide === "home" ? home : away,
      probability: pickSide === "home" ? homeWinProbability : 1 - homeWinProbability,
    },
    bets,
    confidence,
    keyFactors: buildKeyFactors(context, baseline),
    issues: context.issues,
    context,
    modelVersion: MODEL_VERSION,
    predictedAt: nowIso(),
  };
}

export async function predictDate(options: PredictOptions): Promise<DailyPredictions> {
  const constants = options.constants ?? MLB_CONSTANTS;
  const sources = options.sources ?? createSources(options.config);
  const collector = new Collector(options.config, sources, constants);
  const collection = await collector.collect(options.date);

  const games = collection.contexts.map((context) =>
    predictGame(context, options.calibration, options.config, constants),
  );

  // Highest confidence first, then the biggest edge inside a rank.
  const rankOrder = { S: 0, A: 1, B: 2, C: 3 } as const;
  games.sort((a, b) => {
    const byRank = rankOrder[a.confidence.rank] - rankOrder[b.confidence.rank];
    if (byRank !== 0) return byRank;
    return b.confidence.score - a.confidence.score;
  });

  return {
    sport: "MLB",
    date: options.date,
    generatedAt: nowIso(),
    modelVersion: MODEL_VERSION,
    calibrationVersion: options.calibration.version,
    games,
    skipped: collection.skipped,
  };
}
