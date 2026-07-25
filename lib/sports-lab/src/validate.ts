/**
 * Step 3 — Validation / flagging layer.
 *
 * This is the layer the plan calls for in Section 5, step 3: "Check each game
 * has what it needs. Flag games with missing/late data." It embodies the data
 * principle "fail loudly, not silently" — every gap becomes a typed {@link Flag}
 * and, where it degrades trust, a cap on the confidence rank a game may earn.
 *
 * The output is advisory: it never invents numbers and never silently drops a
 * game. It tells later stages (confidence ranking, AI review, the report) how
 * far to trust the inputs.
 */
import { type CoreGame, type GameContext, type ConfidenceRank } from "./schemas";
import {
  type Flag,
  type FlagSeverity,
  CONFIDENCE_ORDER,
  maxSeverity,
  minRank,
} from "./flags";
import { hasMaterialAbsence, materialAbsences } from "./context/injuries";
import { isForecastStale, roofNeutralizesWeather } from "./context/weather";

export interface ValidateOptions {
  /** Reference "now" (ISO) for staleness checks. Defaults to the current time. */
  asOf?: string;
  /** A source older than this many hours (vs `asOf`) is flagged stale. */
  staleAfterHours?: number;
  /** Forecast target may differ from first pitch by at most this many hours. */
  forecastToleranceHours?: number;
  /** Recent-form samples smaller than this are flagged as thin. */
  smallSampleMin?: number;
  /** Precipitation chance at/above this (0..1) is flagged as a rain risk. */
  precipRiskChance?: number;
}

const DEFAULTS: Required<Omit<ValidateOptions, "asOf">> = {
  staleAfterHours: 24,
  forecastToleranceHours: 3,
  smallSampleMin: 5,
  precipRiskChance: 0.5,
};

export interface ValidationResult {
  gameId: string;
  /** All flags raised, most severe first. */
  flags: Flag[];
  /** Highest severity across flags, or null when clean. */
  severity: FlagSeverity | null;
  /** True when at least one error-level flag is present. */
  hasErrors: boolean;
  /** Fraction (0..1) of the required inputs that are present and usable. */
  completeness: number;
  /** The best confidence rank this game's data quality permits. */
  confidenceCap: ConfidenceRank;
}

/** Per-rule confidence caps. The final cap is the weakest one triggered. */
const CAP = {
  missingStarter: "C",
  unconfirmedStarter: "A",
  weatherMissing: "B",
  weatherStale: "A",
  precipRisk: "A",
  parkFallback: "A",
  lineupUnconfirmed: "A",
  formMissing: "B",
  missingBatting: "C",
  missingBullpen: "B",
} as const satisfies Record<string, ConfidenceRank>;

/** Bullpen innings over the last 3 days beyond which fatigue is flagged. */
const BULLPEN_FATIGUE_IP = 9;

function hoursBetween(aISO: string, bISO: string): number {
  return Math.abs(Date.parse(aISO) - Date.parse(bISO)) / 3_600_000;
}

/**
 * Validate one game's core data + assembled context, returning typed flags,
 * a completeness score, and the confidence cap those inputs justify.
 */
export function validateGame(
  game: CoreGame,
  context: GameContext,
  options: ValidateOptions = {},
): ValidationResult {
  const opts = { ...DEFAULTS, ...options };
  const asOf = options.asOf ?? new Date().toISOString();
  const flags: Flag[] = [];
  let cap: ConfidenceRank = "S";
  const applyCap = (rank: ConfidenceRank) => {
    cap = minRank(cap, rank);
  };

  // A checklist of "required inputs present?" booleans → completeness score.
  const checklist: boolean[] = [];
  const require = (present: boolean) => checklist.push(present);

  /* --- Starting pitchers (biggest single driver) ------------------------- */
  for (const side of ["home", "away"] as const) {
    const starter = side === "home" ? game.homeStarter : game.awayStarter;
    require(starter !== null);
    if (starter === null) {
      flags.push({
        code: "missing_starter",
        severity: "error",
        field: `${side}Starter`,
        message: `No starting pitcher named for the ${side} team.`,
      });
      applyCap(CAP.missingStarter);
    } else if (!starter.confirmed) {
      flags.push({
        code: "unconfirmed_starter",
        severity: "warn",
        field: `${side}Starter`,
        message: `${side} starter ${starter.name} is not officially confirmed.`,
      });
      applyCap(CAP.unconfirmedStarter);
    }
  }

  /* --- Team batting & bullpen (Step 2 inputs the baseline model needs) ---- */
  for (const side of ["home", "away"] as const) {
    const batting = side === "home" ? game.homeBatting : game.awayBatting;
    // runsPerGame is the offense anchor — absent, the baseline cannot run.
    const battingUsable = batting !== null && batting.runsPerGame !== null;
    require(battingUsable);
    if (!battingUsable) {
      flags.push({
        code: "missing_batting",
        severity: "error",
        field: `${side}Batting`,
        message: `No team batting runs/game for the ${side} team; offense cannot be modeled.`,
      });
      applyCap(CAP.missingBatting);
    }

    const bullpen = side === "home" ? game.homeBullpen : game.awayBullpen;
    const bullpenUsable = bullpen !== null && bullpen.era !== null;
    require(bullpenUsable);
    if (!bullpenUsable) {
      flags.push({
        code: "missing_bullpen",
        severity: "warn",
        field: `${side}Bullpen`,
        message: `No bullpen ERA for the ${side} team; late-inning run prevention is unmodeled.`,
      });
      applyCap(CAP.missingBullpen);
    } else if (
      bullpen.inningsPitchedLast3Days !== null &&
      bullpen.inningsPitchedLast3Days > BULLPEN_FATIGUE_IP
    ) {
      // Real signal for the model, not a data defect → info, no cap.
      flags.push({
        code: "bullpen_fatigue",
        severity: "info",
        field: `${side}Bullpen`,
        message: `${side} bullpen threw ${bullpen.inningsPitchedLast3Days} innings in the last 3 days.`,
      });
    }
  }

  /* --- Weather (observed vs forecast is first-class) --------------------- */
  const weather = context.weather;
  const roofCovers = roofNeutralizesWeather(weather);
  const weatherEmpty =
    weather.temperatureF === null &&
    weather.windSpeedMph === null &&
    weather.precipitationChance === null;

  // Required unless a closed roof takes weather out of play.
  require(roofCovers || !weatherEmpty);

  if (!roofCovers) {
    if (weatherEmpty) {
      flags.push({
        code: "weather_missing",
        severity: "warn",
        field: "weather",
        message: "No usable weather data and the venue is not a closed roof.",
      });
      applyCap(CAP.weatherMissing);
    } else {
      // Surface the observed-vs-forecast mode explicitly (info, no cap on its
      // own): a forecast is normal for a morning run, but must be labeled.
      if (weather.weatherMode === "forecast") {
        flags.push({
          code: "weather_forecast",
          severity: "info",
          field: "weather",
          message: "Weather is a forecast, not an observed reading.",
        });
        if (isForecastStale(weather, game.startTime, opts.forecastToleranceHours)) {
          flags.push({
            code: "weather_forecast_stale",
            severity: "warn",
            field: "weather.forecastFor",
            message: `Forecast target time is more than ${opts.forecastToleranceHours}h from first pitch.`,
          });
          applyCap(CAP.weatherStale);
        }
      }
      if (
        weather.precipitationChance !== null &&
        weather.precipitationChance >= opts.precipRiskChance
      ) {
        flags.push({
          code: "weather_precip_risk",
          severity: "warn",
          field: "weather.precipitationChance",
          message: `Precipitation chance ${Math.round(
            weather.precipitationChance * 100,
          )}% — run environment and postponement risk.`,
        });
        applyCap(CAP.precipRisk);
      }
    }
  }

  /* --- Ballpark factors -------------------------------------------------- */
  require(!context.ballpark.isNeutralFallback);
  if (context.ballpark.isNeutralFallback) {
    flags.push({
      code: "park_factors_fallback",
      severity: "warn",
      field: "ballpark",
      message: `No park-factor entry for venue ${context.ballpark.venueId}; using neutral 1.0.`,
    });
    applyCap(CAP.parkFallback);
  }

  /* --- Injuries & lineups ------------------------------------------------ */
  for (const side of ["home", "away"] as const) {
    const report = context.injuries[side];
    require(report.lineupConfirmed);
    if (!report.lineupConfirmed) {
      flags.push({
        code: "lineup_unconfirmed",
        severity: "warn",
        field: `injuries.${side}`,
        message: `${side} lineup not officially posted; injury impact is provisional.`,
      });
      applyCap(CAP.lineupUnconfirmed);
    }
    if (hasMaterialAbsence(report)) {
      const names = materialAbsences(report)
        .map((i) => i.name)
        .join(", ");
      // Real signal for the model, not a data defect → info, no cap.
      flags.push({
        code: "injury_key_player_out",
        severity: "info",
        field: `injuries.${side}`,
        message: `${side} missing key player(s): ${names}.`,
      });
    }
  }

  /* --- Recent form ------------------------------------------------------- */
  for (const side of ["home", "away"] as const) {
    const form = context.recentForm[side];
    require(form.sampleSize > 0);
    if (form.sampleSize === 0) {
      flags.push({
        code: "recent_form_missing",
        severity: "warn",
        field: `recentForm.${side}`,
        message: `No recent-form data for the ${side} team.`,
      });
      applyCap(CAP.formMissing);
    } else if (form.sampleSize < opts.smallSampleMin) {
      flags.push({
        code: "recent_form_small_sample",
        severity: "info",
        field: `recentForm.${side}`,
        message: `${side} recent form based on only ${form.sampleSize} game(s); treat trend as noisy.`,
      });
    }
  }

  /* --- Staleness (timestamp everything) ---------------------------------- */
  const sources: Array<{ field: string; fetchedAt: string }> = [
    { field: "recentForm.home", fetchedAt: context.recentForm.home.fetchedAt },
    { field: "recentForm.away", fetchedAt: context.recentForm.away.fetchedAt },
    { field: "injuries.home", fetchedAt: context.injuries.home.fetchedAt },
    { field: "injuries.away", fetchedAt: context.injuries.away.fetchedAt },
    { field: "weather", fetchedAt: context.weather.fetchedAt },
  ];
  for (const src of sources) {
    if (hoursBetween(src.fetchedAt, asOf) > opts.staleAfterHours) {
      flags.push({
        code: "stale_data",
        severity: "warn",
        field: src.field,
        message: `${src.field} was fetched more than ${opts.staleAfterHours}h ago.`,
      });
      applyCap("A");
    }
  }

  // Error-level flags floor the cap at the worst rank.
  const severity = maxSeverity(flags);
  if (severity === "error") cap = "C";

  const completeness =
    checklist.length === 0 ? 1 : checklist.filter(Boolean).length / checklist.length;

  const severityOrder: Record<FlagSeverity, number> = { error: 0, warn: 1, info: 2 };
  flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    gameId: game.gameId,
    flags,
    severity,
    hasErrors: severity === "error",
    completeness,
    confidenceCap: cap,
  };
}

/** Validate a batch of games; convenience over mapping `validateGame`. */
export function validateGames(
  entries: ReadonlyArray<{ game: CoreGame; context: GameContext }>,
  options: ValidateOptions = {},
): ValidationResult[] {
  return entries.map((e) => validateGame(e.game, e.context, options));
}

export { CONFIDENCE_ORDER };
