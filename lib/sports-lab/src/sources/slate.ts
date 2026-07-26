/**
 * Slate assembly — combine every provider into pipeline input.
 *
 * `fetchSlate` is the one call that turns a date into `SlateEntry[]`, ready
 * for `runDailyPipeline`. It fans out across three independent services:
 *
 *   - MLB Stats API  → schedule, starters, batting, bullpen, recent form
 *   - Open-Meteo     → weather at each park's first-pitch hour
 *   - The Odds API   → moneyline / run line / total (needs an API key)
 *
 * **A provider being down degrades the slate; it does not cancel it.** Weather
 * and odds are optional inputs: without weather a game still predicts (and the
 * validation layer raises `weather_missing`), and without odds it produces
 * probabilities but no bet. Only the MLB call is load-bearing, because without
 * it there is no game to predict. Every degradation is reported rather than
 * silently absorbed.
 */
import type { CoreGame, GameContext, GameOdds, TeamInjuryReport } from "../schemas";
import type { SlateEntry } from "../pipeline";
import { assembleGameContext } from "../context/assemble";
import { MlbClient, type MlbClientOptions } from "./mlb/client";
import { fetchCoreGames, fetchRecentForm, type FetchCoreGamesOptions } from "./mlb/fetch";
import { fetchWeather, type WeatherProviderOptions } from "./openmeteo";
import { fetchOddsForSlate, type OddsProviderOptions } from "./oddsapi";

export interface FetchSlateOptions {
  /** Reference "now": decides observed-vs-forecast and stamps every record. */
  asOf?: string;
  /** Pass a pre-built client to inject `fetch`, tune retries, or share it. */
  mlbClient?: MlbClient;
  /** Used only when `mlbClient` is omitted. */
  mlbClientOptions?: MlbClientOptions;
  mlb?: FetchCoreGamesOptions;
  weather?: WeatherProviderOptions;
  /** Odds are skipped entirely when this is omitted or carries no API key. */
  odds?: OddsProviderOptions;
  /** Recent-form window. Defaults to 10 games. */
  formWindow?: number;
  /** Supply real injury reports; defaults to an empty, unconfirmed report. */
  injuriesFor?: (game: CoreGame, side: "home" | "away") => TeamInjuryReport;
}

export interface FetchSlateResult {
  date: string;
  entries: SlateEntry[];
  /** Everything that could not be fetched, per source. */
  problems: { gameId: string | null; source: "mlb" | "weather" | "odds"; message: string }[];
}

/**
 * An empty injury report.
 *
 * `lineupConfirmed: false` is the honest default: no injury source has been
 * consulted, so the validation layer raises `lineup_unconfirmed` and caps the
 * game at A rather than letting an unchecked lineup pass as clean.
 */
function emptyInjuries(teamId: string, fetchedAt: string): TeamInjuryReport {
  return { teamId, injuries: [], lineupConfirmed: false, fetchedAt };
}

/** Fetch a full day's slate from every provider. */
export async function fetchSlate(
  date: string,
  options: FetchSlateOptions = {},
): Promise<FetchSlateResult> {
  const asOf = options.asOf ?? new Date().toISOString();
  const problems: FetchSlateResult["problems"] = [];
  const client = options.mlbClient ?? new MlbClient(options.mlbClientOptions);

  /* --- MLB: load-bearing ------------------------------------------------- */
  const core = await fetchCoreGames(client, date, { fetchedAt: asOf, ...options.mlb });
  for (const failure of core.failures) {
    problems.push({ gameId: String(failure.gamePk), source: "mlb", message: failure.message });
  }

  /* --- Odds: optional, one call for the whole slate ----------------------- */
  let oddsByGame = new Map<string, GameOdds>();
  if (options.odds !== undefined) {
    try {
      const matched = await fetchOddsForSlate(core.games, asOf, options.odds);
      oddsByGame = matched.odds;
      for (const miss of matched.unmatched) {
        problems.push({ gameId: miss.gameId, source: "odds", message: miss.reason });
      }
    } catch (error) {
      // One failure for the whole slate — record it once, not per game.
      problems.push({
        gameId: null,
        source: "odds",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /* --- Per-game context --------------------------------------------------- */
  const entries: SlateEntry[] = [];
  for (const game of core.games) {
    const [homeForm, awayForm] = await Promise.all([
      fetchRecentForm(client, Number(game.home.id), date, asOf, { window: options.formWindow }),
      fetchRecentForm(client, Number(game.away.id), date, asOf, { window: options.formWindow }),
    ]);

    let weather;
    try {
      weather = await fetchWeather(
        { homeAbbreviation: game.home.abbreviation, firstPitch: game.startTime, asOf },
        options.weather ?? {},
      );
    } catch (error) {
      problems.push({
        gameId: game.gameId,
        source: "weather",
        message: error instanceof Error ? error.message : String(error),
      });
      // Nulls throughout, so `weather_missing` fires rather than a fake reading.
      weather = {
        weatherMode: "forecast" as const,
        forecastFor: game.startTime,
        temperatureF: null,
        windSpeedMph: null,
        windRelative: null,
        precipitationChance: null,
        roofState: "none" as const,
        fetchedAt: asOf,
      };
    }

    const context: GameContext = assembleGameContext(game, {
      recentForm: { home: homeForm, away: awayForm },
      injuries: {
        home: options.injuriesFor?.(game, "home") ?? emptyInjuries(game.home.id, asOf),
        away: options.injuriesFor?.(game, "away") ?? emptyInjuries(game.away.id, asOf),
      },
      weather,
    });

    entries.push({ game, context, odds: oddsByGame.get(game.gameId) ?? null });
  }

  return { date, entries, problems };
}
