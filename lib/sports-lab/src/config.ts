/**
 * Runtime configuration and model constants.
 *
 * Two kinds of knobs live here:
 *   1. Environment/runtime settings (paths, API keys, simulation count).
 *   2. Model constants that are *not* learned from data (league baselines,
 *      home-field advantage, weather sensitivities).
 *
 * Anything the loop learns from recorded results lives in `calibration.json`
 * instead — see `loop/calibrate.ts`. Keeping the two separate is what makes
 * "improve" a real step rather than hand-tuning.
 */

import path from "node:path";

export const MODEL_VERSION = "sports-lab/1.0.0";

export interface RuntimeConfig {
  /** Root for all persisted data: predictions, results, cache, calibration. */
  dataDir: string;
  /** Directory of recorded/synthetic API responses used in offline mode. */
  fixtureDir: string;
  /**
   * When true, no network calls are made: every source reads from fixtureDir
   * and a missing fixture is a loud error. Used by tests and by `--offline`.
   */
  offline: boolean;
  /** Seconds a cached HTTP response stays fresh. */
  cacheTtlSeconds: number;
  season: number;
  simulations: number;
  /** The Odds API key. Null disables all odds/EV output (loudly). */
  oddsApiKey: string | null;
  /** Preferred sportsbook key from The Odds API, e.g. "draftkings". */
  oddsBook: string;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Minimum gap between calls to the same host, to stay polite. */
  minRequestIntervalMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return Math.trunc(parsed);
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Default season = current year; MLB seasons do not straddle new year. */
function defaultSeason(): number {
  return envInt("SPORTS_LAB_SEASON", new Date().getUTCFullYear());
}

export function loadRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const dataDir =
    process.env["SPORTS_LAB_DATA_DIR"] ?? path.join(packageRoot, "data");
  const key = process.env["ODDS_API_KEY"]?.trim();
  return {
    dataDir,
    fixtureDir:
      process.env["SPORTS_LAB_FIXTURE_DIR"] ?? path.join(packageRoot, "fixtures"),
    offline: envFlag("SPORTS_LAB_OFFLINE"),
    cacheTtlSeconds: envInt("SPORTS_LAB_CACHE_TTL", 6 * 60 * 60),
    season: defaultSeason(),
    simulations: envInt("SPORTS_LAB_SIMS", 20000),
    oddsApiKey: key && key.length > 0 ? key : null,
    oddsBook: process.env["SPORTS_LAB_ODDS_BOOK"] ?? "draftkings",
    requestTimeoutMs: envInt("SPORTS_LAB_TIMEOUT_MS", 20000),
    maxRetries: envInt("SPORTS_LAB_MAX_RETRIES", 3),
    minRequestIntervalMs: envInt("SPORTS_LAB_MIN_INTERVAL_MS", 120),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

export interface ModelConstants {
  /** League average runs scored per team per game. */
  leagueRunsPerGame: number;
  /** League average runs allowed per 9 innings. */
  leagueRunsAllowedPer9: number;
  /** League average innings per start. */
  leagueInningsPerStart: number;

  /**
   * League-average rate stats, used only as the normalisation point for the
   * component run estimate. Because that estimate is rescaled so that these
   * inputs map exactly to `leagueRunsPerGame`, small errors here cancel out.
   */
  leagueReference: { onBasePct: number; sluggingPct: number };

  /**
   * Coefficients of a linear run estimate from team OBP and SLG. The absolute
   * scale is irrelevant — only the OBP:SLG ratio survives normalisation. OBP
   * carries roughly 2.5x the weight of SLG, which is the well-established
   * result and the reason a high-OBP team outscores its slugging.
   */
  componentRunWeights: { onBasePct: number; sluggingPct: number; intercept: number };

  /** Extra runs a fully-taxed bullpen allows, as a multiplier at fatigue = 1. */
  bullpenFatiguePenalty: number;

  /**
   * Shrinkage strengths, expressed in the sample units of each stat. A team
   * with `k` games of data gets 50% weight on its own number, 50% on league
   * average. These are deliberately conservative: team rate stats are noisy
   * and the market is sharp.
   */
  shrink: {
    /** Games, for team offense. */
    teamOffenseGames: number;
    /** Innings, for a starting pitcher's RA9. */
    starterInnings: number;
    /** Innings, for bullpen RA9. */
    bullpenInnings: number;
    /** Starts, for innings-per-start. */
    inningsPerStartStarts: number;
  };

  /**
   * Home-field advantage as multipliers on expected runs. The net effect is a
   * home win rate near 53%, matching recent MLB seasons (it was ~54% in the
   * 2000s and has drifted down).
   */
  homeFieldAdvantage: { homeOffense: number; awayOffense: number };

  /** Weight on "last N games" form versus season-long numbers. */
  recentFormWeight: number;
  recentFormGames: number;

  /** Runs multiplier applied per injured-list player, capped. */
  injury: { perPlayerPenalty: number; maxPenalty: number };

  weather: {
    /** Runs multiplier per degree F above/below the reference temperature. */
    perDegreeF: number;
    referenceTempF: number;
    /** Runs multiplier per mph of wind blowing out to center field. */
    perMphOut: number;
    /** Absolute cap on the combined weather multiplier deviation. */
    maxDeviation: number;
  };

  /** Extra-innings scoring, post automatic-runner rule (2023+). */
  extraInnings: { awayRunsPerInning: number; homeRunsPerInning: number; maxInnings: number };

  /** Minimum model-vs-market edge to call a bet positive EV. */
  minEdgeForBet: number;
  /** Cap on the reported Kelly fraction, before halving. */
  maxKellyFraction: number;
}

/**
 * MLB constants. Sourced from recent league-wide averages (2023-2025 era) and
 * rounded — they are baselines, not precision inputs. `runsPerGame` and
 * `runsAllowedPer9` are re-derived by the baseline model's normalisation step,
 * so a small error here does not bias individual games.
 */
export const MLB_CONSTANTS: ModelConstants = {
  leagueRunsPerGame: 4.4,
  leagueRunsAllowedPer9: 4.45,
  leagueInningsPerStart: 5.2,
  leagueReference: { onBasePct: 0.312, sluggingPct: 0.399 },
  componentRunWeights: { onBasePct: 21.6, sluggingPct: 7.9, intercept: -5.3 },
  bullpenFatiguePenalty: 0.04,
  shrink: {
    teamOffenseGames: 45,
    starterInnings: 60,
    bullpenInnings: 120,
    inningsPerStartStarts: 6,
  },
  homeFieldAdvantage: { homeOffense: 1.018, awayOffense: 0.982 },
  recentFormWeight: 0.18,
  recentFormGames: 15,
  injury: { perPlayerPenalty: 0.004, maxPenalty: 0.03 },
  weather: {
    perDegreeF: 0.0035,
    referenceTempF: 70,
    perMphOut: 0.008,
    maxDeviation: 0.1,
  },
  extraInnings: { awayRunsPerInning: 0.6, homeRunsPerInning: 0.64, maxInnings: 6 },
  minEdgeForBet: 0.02,
  maxKellyFraction: 0.05,
};

export const SOURCE_URLS = {
  mlbStatsApi: "https://statsapi.mlb.com/api/v1",
  openMeteo: "https://api.open-meteo.com/v1/forecast",
  theOddsApi: "https://api.the-odds-api.com/v4",
} as const;
