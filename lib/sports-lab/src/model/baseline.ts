/**
 * Step 4 — Baseline statistical model.
 *
 * Produces each team's expected runs as a **transparent chain of named
 * adjustments**, starting from the league average and multiplying step by
 * step. Every step is recorded in the result, so a beginner can read the
 * trace and see exactly why a team is favored (plan Section 4.1).
 *
 *   league average
 *     → team offense
 *     → opposing starter
 *     → opposing bullpen (+ fatigue)
 *     → recent form
 *     → injuries
 *     → ballpark
 *     → weather
 *     → home-field advantage
 *
 * Deliberately explainable over clever: no black box, no fitted weights. All
 * constants live in `constants.ts` for Step 8 to calibrate.
 *
 * **Missing data is never invented.** A source the model can work without is
 * skipped and the skip is recorded as a step with `applied: false`. The one
 * input it cannot substitute for — team batting runs/game — raises
 * {@link BaselineInputError}. Run `validateGame` first and do not model games
 * whose `hasErrors` is true.
 */
import type { CoreGame, GameContext, Side, WeatherMode } from "../schemas";
import { materialAbsences } from "../context/injuries";
import { roofNeutralizesWeather } from "../context/weather";
import {
  BULLPEN_FATIGUE_CAP,
  BULLPEN_FATIGUE_IP_THRESHOLD,
  BULLPEN_FATIGUE_PER_IP,
  BULLPEN_INNINGS,
  FORECAST_WEATHER_DAMPING,
  FORM_WEIGHT,
  HOME_FIELD_ADVANTAGE,
  INJURY_KEY_HITTER_PENALTY,
  INJURY_PENALTY_CAP,
  LEAGUE_ERA,
  LEAGUE_RUNS_PER_GAME,
  OFFENSE_SHRINK,
  PITCHING_SHRINK,
  STARTER_INNINGS,
  TEMP_EFFECT_CAP,
  TEMP_EFFECT_PER_DEGREE,
  TEMP_REFERENCE_F,
  WIND_EFFECT_MAX_MPH,
  WIND_EFFECT_PER_MPH,
} from "./constants";

/** Raised when an input the model cannot substitute for is absent. */
export class BaselineInputError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    super(`Cannot compute baseline: missing required input(s): ${missing.join(", ")}`);
    this.name = "BaselineInputError";
    this.missing = missing;
  }
}

/** One named adjustment in the chain. */
export interface AdjustmentStep {
  /** Short human-readable name, e.g. "Opposing starter". */
  label: string;
  /** The multiplier applied (1.0 = no effect). */
  multiplier: number;
  runsBefore: number;
  runsAfter: number;
  /** Why this multiplier — or why the step was skipped. */
  note: string;
  /** False when the input was missing and the step was skipped. */
  applied: boolean;
}

export interface TeamRunEstimate {
  teamId: string;
  side: Side;
  /** Expected runs for this team, after the full adjustment chain. */
  expectedRuns: number;
  /** The full trace, in order. */
  steps: AdjustmentStep[];
}

export interface BaselineResult {
  gameId: string;
  home: TeamRunEstimate;
  away: TeamRunEstimate;
  /** Combined expected runs — the anchor for the total (over/under). */
  expectedTotal: number;
  /** Home minus away. Positive means the home team is favored. */
  expectedMargin: number;
  /**
   * Carried through from the weather input so downstream stages and the
   * report never have to guess whether the weather adjustment came from a
   * live reading or a forecast.
   */
  weatherMode: WeatherMode;
  /** True when a weather adjustment was actually applied (not roof-neutralized). */
  weatherApplied: boolean;
}

/** Pull a ratio toward 1.0 by `weight` (1.0 = full trust, 0 = neutral). */
function shrink(ratio: number, weight: number): number {
  return 1 + (ratio - 1) * weight;
}

/** Clamp a value into [-cap, cap]. */
function clampDeviation(value: number, cap: number): number {
  return Math.max(-cap, Math.min(cap, value));
}

/** Round to `places` decimals — used only to keep the trace readable. */
function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Builder that applies multipliers in order while recording the trace.
 * Keeping the bookkeeping here lets each rule below read as one line.
 */
class Chain {
  private runs: number;
  readonly steps: AdjustmentStep[] = [];

  constructor(start: number, note: string) {
    this.runs = start;
    this.steps.push({
      label: "League average",
      multiplier: 1,
      runsBefore: start,
      runsAfter: start,
      note,
      applied: true,
    });
  }

  apply(label: string, multiplier: number, note: string): void {
    const before = this.runs;
    this.runs = before * multiplier;
    this.steps.push({
      label,
      multiplier: round(multiplier),
      runsBefore: round(before, 3),
      runsAfter: round(this.runs, 3),
      note,
      applied: true,
    });
  }

  skip(label: string, note: string): void {
    this.steps.push({
      label,
      multiplier: 1,
      runsBefore: round(this.runs, 3),
      runsAfter: round(this.runs, 3),
      note,
      applied: false,
    });
  }

  get value(): number {
    return this.runs;
  }
}

/** Weather multiplier plus the note explaining it. */
function weatherAdjustment(context: GameContext): { multiplier: number; note: string; applied: boolean } {
  const w = context.weather;

  if (roofNeutralizesWeather(w)) {
    return { multiplier: 1, note: "Closed roof — weather neutralized.", applied: false };
  }

  let deviation = 0;
  const parts: string[] = [];

  if (w.temperatureF !== null) {
    const tempDev = clampDeviation(
      (w.temperatureF - TEMP_REFERENCE_F) * TEMP_EFFECT_PER_DEGREE,
      TEMP_EFFECT_CAP,
    );
    deviation += tempDev;
    parts.push(`${w.temperatureF}°F`);
  }

  if (w.windSpeedMph !== null && w.windRelative !== null) {
    const speed = Math.min(w.windSpeedMph, WIND_EFFECT_MAX_MPH);
    const direction = w.windRelative === "out" ? 1 : w.windRelative === "in" ? -1 : 0;
    if (direction !== 0) {
      deviation += direction * speed * WIND_EFFECT_PER_MPH;
      parts.push(`wind ${w.windRelative} ${w.windSpeedMph}mph`);
    } else {
      parts.push(`wind ${w.windRelative}`);
    }
  }

  if (parts.length === 0) {
    return { multiplier: 1, note: "No usable weather inputs — no adjustment.", applied: false };
  }

  // The observed-vs-forecast distinction, applied to the number and not just
  // flagged: a forecast moves the estimate less than a live reading.
  let note = parts.join(", ");
  if (w.weatherMode === "forecast") {
    deviation *= FORECAST_WEATHER_DAMPING;
    note += ` (forecast — damped to ${Math.round(FORECAST_WEATHER_DAMPING * 100)}%)`;
  } else {
    note += " (observed)";
  }

  return { multiplier: 1 + deviation, note, applied: true };
}

/** Compute one team's expected runs against the opposing pitching. */
function estimateSide(game: CoreGame, context: GameContext, side: Side): TeamRunEstimate {
  const isHome = side === "home";
  const team = isHome ? game.home : game.away;
  const batting = isHome ? game.homeBatting : game.awayBatting;
  // The *opposing* staff is what suppresses this team's runs.
  const oppStarter = isHome ? game.awayStarter : game.homeStarter;
  const oppBullpen = isHome ? game.awayBullpen : game.homeBullpen;
  const form = context.recentForm[side];
  const injuries = context.injuries[side];

  if (batting === null || batting.runsPerGame === null) {
    throw new BaselineInputError([`${side}Batting.runsPerGame`]);
  }

  const chain = new Chain(
    LEAGUE_RUNS_PER_GAME,
    `League baseline of ${LEAGUE_RUNS_PER_GAME} runs per team per game.`,
  );

  /* --- Team offense ------------------------------------------------------ */
  chain.apply(
    "Team offense",
    shrink(batting.runsPerGame / LEAGUE_RUNS_PER_GAME, OFFENSE_SHRINK),
    `${team.abbreviation} scores ${batting.runsPerGame} r/g vs league ${LEAGUE_RUNS_PER_GAME} ` +
      `(trusted at ${Math.round(OFFENSE_SHRINK * 100)}%).`,
  );

  /* --- Opposing starter, weighted by the innings they cover -------------- */
  if (oppStarter !== null && oppStarter.seasonEra !== null) {
    const raw = shrink(oppStarter.seasonEra / LEAGUE_ERA, PITCHING_SHRINK);
    // Only the starter's share of the game is affected.
    const weighted = 1 + (raw - 1) * (STARTER_INNINGS / 9);
    chain.apply(
      "Opposing starter",
      weighted,
      `${oppStarter.name} ${oppStarter.seasonEra} ERA vs league ${LEAGUE_ERA}, ` +
        `over ~${STARTER_INNINGS} of 9 innings.`,
    );
  } else {
    chain.skip("Opposing starter", "No opposing starter ERA available — no adjustment.");
  }

  /* --- Opposing bullpen, weighted by the innings they cover -------------- */
  if (oppBullpen !== null && oppBullpen.era !== null) {
    const raw = shrink(oppBullpen.era / LEAGUE_ERA, PITCHING_SHRINK);
    const weighted = 1 + (raw - 1) * (BULLPEN_INNINGS / 9);
    chain.apply(
      "Opposing bullpen",
      weighted,
      `Opposing bullpen ${oppBullpen.era} ERA vs league ${LEAGUE_ERA}, ` +
        `over ~${round(BULLPEN_INNINGS, 1)} of 9 innings.`,
    );

    /* --- Bullpen fatigue ------------------------------------------------- */
    const ip3 = oppBullpen.inningsPitchedLast3Days;
    if (ip3 !== null && ip3 > BULLPEN_FATIGUE_IP_THRESHOLD) {
      const fatigue = Math.min(
        (ip3 - BULLPEN_FATIGUE_IP_THRESHOLD) * BULLPEN_FATIGUE_PER_IP,
        BULLPEN_FATIGUE_CAP,
      );
      chain.apply(
        "Opposing bullpen fatigue",
        1 + fatigue,
        `Opposing bullpen threw ${ip3} innings in the last 3 days.`,
      );
    }
  } else {
    chain.skip("Opposing bullpen", "No opposing bullpen ERA available — no adjustment.");
  }

  /* --- Recent form, weighted by how much sample we actually have --------- */
  if (form.sampleSize > 0 && form.runsScoredPerGame !== null) {
    const weight = FORM_WEIGHT * (form.sampleSize / form.window);
    const ratio = form.runsScoredPerGame / batting.runsPerGame;
    chain.apply(
      "Recent form",
      1 + (ratio - 1) * weight,
      `Last ${form.sampleSize} games: ${round(form.runsScoredPerGame, 2)} r/g vs season ` +
        `${batting.runsPerGame} (weighted ${Math.round(weight * 100)}% for sample size).`,
    );
  } else {
    chain.skip("Recent form", "No recent-form data — no adjustment.");
  }

  /* --- Injuries: only key hitters ruled out affect this team's offense --- */
  const absentHitters = materialAbsences(injuries).filter((i) => i.impact === "key-hitter");
  if (absentHitters.length > 0) {
    const penalty = Math.min(
      absentHitters.length * INJURY_KEY_HITTER_PENALTY,
      INJURY_PENALTY_CAP,
    );
    chain.apply(
      "Injuries",
      1 - penalty,
      `${absentHitters.length} key hitter(s) out: ${absentHitters.map((i) => i.name).join(", ")}.`,
    );
  } else {
    chain.skip("Injuries", "No key hitters ruled out.");
  }

  /* --- Ballpark ---------------------------------------------------------- */
  const park = context.ballpark;
  if (park.isNeutralFallback) {
    chain.skip("Ballpark", `No park-factor entry for ${game.venueName} — treated as neutral.`);
  } else {
    chain.apply(
      "Ballpark",
      park.runsFactor,
      `${game.venueName} runs factor ${park.runsFactor}.`,
    );
  }

  /* --- Weather ----------------------------------------------------------- */
  const weather = weatherAdjustment(context);
  if (weather.applied) {
    chain.apply("Weather", weather.multiplier, weather.note);
  } else {
    chain.skip("Weather", weather.note);
  }

  /* --- Home-field advantage ---------------------------------------------- */
  if (isHome) {
    chain.apply("Home-field advantage", HOME_FIELD_ADVANTAGE, "Home team.");
  } else {
    chain.skip("Home-field advantage", "Away team — no adjustment.");
  }

  return {
    teamId: team.id,
    side,
    expectedRuns: round(chain.value, 3),
    steps: chain.steps,
  };
}

/**
 * Run the baseline model for one game.
 *
 * @throws {BaselineInputError} when either team's batting runs/game is absent.
 */
export function computeBaseline(game: CoreGame, context: GameContext): BaselineResult {
  // Report *all* missing anchors at once rather than failing on the first.
  const missing: string[] = [];
  if (game.homeBatting === null || game.homeBatting.runsPerGame === null) {
    missing.push("homeBatting.runsPerGame");
  }
  if (game.awayBatting === null || game.awayBatting.runsPerGame === null) {
    missing.push("awayBatting.runsPerGame");
  }
  if (missing.length > 0) throw new BaselineInputError(missing);

  const home = estimateSide(game, context, "home");
  const away = estimateSide(game, context, "away");

  return {
    gameId: game.gameId,
    home,
    away,
    expectedTotal: round(home.expectedRuns + away.expectedRuns, 3),
    expectedMargin: round(home.expectedRuns - away.expectedRuns, 3),
    weatherMode: context.weather.weatherMode,
    weatherApplied: weatherAdjustment(context).applied,
  };
}

/**
 * Render a run estimate's trace as plain text lines — the "show your work"
 * view for the daily report (Step 10) and for debugging.
 */
export function explainEstimate(estimate: TeamRunEstimate): string[] {
  const lines = estimate.steps.map((s) => {
    if (!s.applied) return `  · ${s.label}: skipped — ${s.note}`;
    const pct = (s.multiplier - 1) * 100;
    const sign = pct >= 0 ? "+" : "";
    return `  · ${s.label}: ${sign}${pct.toFixed(1)}% → ${s.runsAfter.toFixed(2)} runs — ${s.note}`;
  });
  return [`${estimate.side} expected runs: ${estimate.expectedRuns.toFixed(2)}`, ...lines];
}
