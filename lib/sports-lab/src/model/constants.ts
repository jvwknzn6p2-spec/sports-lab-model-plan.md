/**
 * Step 4 — Tunable constants for the baseline statistical model.
 *
 * Every magic number the model uses lives here, in one place, so the model
 * reads as a sequence of named adjustments and so Step 8 (backtesting) has a
 * single surface to calibrate against. Values are reasonable v1.0 starting
 * points, not fitted parameters — backtesting is what earns them.
 */

/** League-average runs scored per team per game. */
export const LEAGUE_RUNS_PER_GAME = 4.4;

/** League-average ERA, the yardstick for pitcher/bullpen quality. */
export const LEAGUE_ERA = 4.1;

/** Typical innings covered by the starter vs the bullpen (sums to 9). */
export const STARTER_INNINGS = 5.2;
export const BULLPEN_INNINGS = 9 - STARTER_INNINGS;

/**
 * Shrinkage weights, in [0,1]. A weight of 1.0 trusts the raw ratio fully;
 * lower values pull it toward league average. Season stats carry real signal
 * but also park/schedule noise, so nothing is trusted at face value.
 */
export const OFFENSE_SHRINK = 0.8;
export const PITCHING_SHRINK = 0.7;

/**
 * How far recent form may pull the season-based offense estimate. Scaled by
 * sampleSize/window, so a 3-game sample moves the number far less than a full
 * 10-game window (plan Section 7: recent form is noisy).
 */
export const FORM_WEIGHT = 0.2;

/** Offense penalty per key hitter ruled out, and the total cap. */
export const INJURY_KEY_HITTER_PENALTY = 0.03;
export const INJURY_PENALTY_CAP = 0.09;

/** Temperature effect: warm air carries the ball. Reference is 70°F. */
export const TEMP_REFERENCE_F = 70;
export const TEMP_EFFECT_PER_DEGREE = 0.004;
/** Clamp on the temperature adjustment, ±. */
export const TEMP_EFFECT_CAP = 0.1;

/** Wind effect per mph blowing out (+) or in (−), and the mph it saturates at. */
export const WIND_EFFECT_PER_MPH = 0.006;
export const WIND_EFFECT_MAX_MPH = 20;

/**
 * Forecast damping. When `weatherMode === "forecast"` the weather adjustment
 * is an estimate of an estimate, so we shrink its deviation from neutral.
 * Observed readings are applied at full strength.
 */
export const FORECAST_WEATHER_DAMPING = 0.6;

/** Bullpen fatigue: innings over the last 3 days beyond which runs tick up. */
export const BULLPEN_FATIGUE_IP_THRESHOLD = 9;
export const BULLPEN_FATIGUE_PER_IP = 0.01;
export const BULLPEN_FATIGUE_CAP = 0.06;

/**
 * Home-field advantage as a run multiplier on the home offense. Small and
 * deliberately conservative.
 */
export const HOME_FIELD_ADVANTAGE = 1.02;

/* -------------------------------------------------------------------------- */
/* Step 5 — Monte Carlo simulation                                            */
/* -------------------------------------------------------------------------- */

/** Simulations per game. The plan's figure; enough for ~0.5% resolution. */
export const DEFAULT_ITERATIONS = 10_000;

/**
 * Default PRNG seed. Fixed rather than time-based so a re-run of the same
 * game with the same inputs reproduces the same probabilities exactly.
 */
export const DEFAULT_SEED = 20_260_101;

/**
 * Negative-binomial dispersion `k` for team runs. Real MLB team run totals
 * have a variance near 9.5 against a mean near 4.4 — far more spread than a
 * Poisson (whose variance equals its mean). Since variance = mean + mean²/k,
 * k ≈ 4 reproduces that spread. Getting this right matters more for totals
 * and run lines than for the moneyline.
 */
export const RUNS_DISPERSION = 4.0;

/** MLB's standard run line. */
export const DEFAULT_RUN_LINE = 1.5;

/**
 * Extra innings start with a runner on second, which roughly doubles the
 * scoring rate of a normal inning.
 */
export const EXTRA_INNING_RUN_MULTIPLIER = 2.0;

/** Safety bound on extra-inning loops so a simulation can never hang. */
export const MAX_EXTRA_INNINGS = 20;

/* -------------------------------------------------------------------------- */
/* Step 7 — Confidence ranking                                                */
/* -------------------------------------------------------------------------- */

/** Edge thresholds (as fractions) for the starting S / A / B tier. */
export const CONFIDENCE_EDGE_S = 0.08;
export const CONFIDENCE_EDGE_A = 0.05;
export const CONFIDENCE_EDGE_B = 0.03;

/**
 * An edge this large is treated as suspicious rather than excellent. The
 * market is sharp (plan Section 7), so a double-digit edge more often means a
 * stale line, a bad input, or a model error than a real opportunity.
 */
export const IMPLAUSIBLE_EDGE = 0.15;

/**
 * How many Monte Carlo standard errors the edge must clear to be treated as
 * a real signal rather than simulation noise. With 10,000 iterations the
 * standard error is ~0.5%, so a 3× bar means edges under ~1.5% never rank high.
 */
export const MIN_EDGE_TO_NOISE_RATIO = 3;

/**
 * Deadband around neutral for the recent-form agreement check. Without it the
 * test sits on a knife edge at exactly 1.0 and roughly half of all games would
 * be penalised for a fraction of a percent — noise, not disagreement.
 */
export const FORM_DISAGREEMENT_TOLERANCE = 0.02;
