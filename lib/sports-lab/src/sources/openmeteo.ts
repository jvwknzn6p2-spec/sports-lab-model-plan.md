/**
 * Weather provider — Open-Meteo.
 *
 * Fills the `Weather` half of `GameContext`. Open-Meteo is free, needs no API
 * key, and serves both forecast and historical hours from one endpoint, which
 * is what lets the same code path serve a live slate and a backtest.
 *
 * **The observed-vs-forecast distinction is decided here, not guessed later.**
 * A weather hour is `observed` only when the requested hour is already in the
 * past relative to the run; otherwise it is a `forecast`. That single field
 * then flows all the way through: the baseline damps a forecast's effect to
 * 60%, the confidence layer penalises a totals pick that leans on one, and the
 * report prints which it was. Getting it wrong here quietly mislabels every
 * downstream consequence, so it is derived from timestamps rather than from
 * which endpoint happened to answer.
 */
import { z } from "zod";
import type { RoofState, Weather, WindRelative } from "../schemas";
import { deriveWindRelative } from "../context/weather";
import { lookupBallparkGeo, type BallparkGeo } from "./ballparks";
import type { FetchLike } from "./mlb/client";

export const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

/** Hourly fields we request, in the units the rest of the library expects. */
const HOURLY_FIELDS = "temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m";

const openMeteoResponseSchema = z.object({
  hourly: z
    .object({
      time: z.array(z.string()).default([]),
      temperature_2m: z.array(z.number().nullable()).default([]),
      precipitation_probability: z.array(z.number().nullable()).default([]),
      wind_speed_10m: z.array(z.number().nullable()).default([]),
      wind_direction_10m: z.array(z.number().nullable()).default([]),
    })
    .optional(),
});

export interface WeatherProviderOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Measured home-plate→center-field bearings, keyed by team abbreviation.
   *
   * The shipped ballpark table leaves these null on purpose (see
   * `ballparks.ts`). Supply them here once you have a source you trust; until
   * then `windRelative` is null and the wind adjustment is skipped rather than
   * being applied with a guessed sign.
   */
  centerFieldBearings?: Readonly<Record<string, number>>;
  /**
   * Roof state for retractable parks on this date, keyed by abbreviation.
   *
   * A retractable roof's position is a game-day decision the weather API
   * cannot know. Unsupplied, retractable parks are treated as open, so weather
   * is applied — the conservative direction, since under-applying weather at a
   * park that turned out to be closed is the milder error.
   */
  retractableRoofState?: Readonly<Record<string, "open" | "closed">>;
}

/** Thrown when the provider cannot produce a usable weather record. */
export class WeatherProviderError extends Error {
  constructor(message: string) {
    super(`Open-Meteo: ${message}`);
    this.name = "WeatherProviderError";
  }
}

/** Round an ISO timestamp down to the hour, in the `YYYY-MM-DDTHH:00` form. */
export function toHourKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid timestamp: ${iso}`);
  return `${date.toISOString().slice(0, 13)}:00`;
}

/** Resolve the roof state to report for a park. */
export function resolveRoofState(
  park: BallparkGeo,
  override: "open" | "closed" | undefined,
): RoofState {
  switch (park.roofType) {
    case "fixed":
      // Permanently enclosed — weather never reaches the field.
      return "closed";
    case "open":
      return "none";
    case "retractable":
      return override ?? "open";
  }
}

interface HourlySlice {
  temperatureF: number | null;
  precipitationChance: number | null;
  windSpeedMph: number | null;
  windFromDeg: number | null;
}

/** Pull the row matching `hourKey` out of Open-Meteo's column-wise arrays. */
function sliceHour(
  hourly: z.infer<typeof openMeteoResponseSchema>["hourly"],
  hourKey: string,
): HourlySlice | null {
  if (hourly === undefined) return null;
  const index = hourly.time.indexOf(hourKey);
  if (index === -1) return null;

  const precip = hourly.precipitation_probability[index] ?? null;
  return {
    temperatureF: hourly.temperature_2m[index] ?? null,
    // Open-Meteo reports probability as a percentage; the schema wants 0..1.
    precipitationChance: precip === null ? null : precip / 100,
    windSpeedMph: hourly.wind_speed_10m[index] ?? null,
    windFromDeg: hourly.wind_direction_10m[index] ?? null,
  };
}

export interface FetchWeatherArgs {
  /** Home-team abbreviation, used to resolve the park. */
  homeAbbreviation: string;
  /** Scheduled first pitch (ISO). The hour we want weather for. */
  firstPitch: string;
  /** Reference "now" — decides observed vs forecast. */
  asOf: string;
  /** Timestamp stamped on the record. Defaults to `asOf`. */
  fetchedAt?: string;
}

/**
 * Fetch the weather for one game's first-pitch hour.
 *
 * Returns a `Weather` record with every field the context layer expects.
 * Missing values stay null so the validation layer can flag them; the provider
 * never substitutes a seasonal average.
 */
export async function fetchWeather(
  args: FetchWeatherArgs,
  options: WeatherProviderOptions = {},
): Promise<Weather> {
  const { homeAbbreviation, firstPitch, asOf } = args;
  const fetchedAt = args.fetchedAt ?? asOf;

  const park = lookupBallparkGeo(homeAbbreviation);
  if (park === null) {
    throw new WeatherProviderError(`no ballpark coordinates for "${homeAbbreviation}"`);
  }

  const roofState = resolveRoofState(park, options.retractableRoofState?.[park.abbreviation]);

  // Derived from timestamps, not from which endpoint answered: the hour is
  // observed only if it has already happened.
  const weatherMode = Date.parse(firstPitch) <= Date.parse(asOf) ? "observed" : "forecast";

  const hourKey = toHourKey(firstPitch);
  const date = hourKey.slice(0, 10);

  const fetchImpl = options.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (fetchImpl === undefined) {
    throw new TypeError("No fetch implementation available; pass one via options.fetch");
  }

  const url =
    `${options.baseUrl ?? OPEN_METEO_BASE}` +
    `?latitude=${park.latitude}&longitude=${park.longitude}` +
    `&hourly=${HOURLY_FIELDS}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&timezone=UTC&start_date=${date}&end_date=${date}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let body: string;
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new WeatherProviderError(`HTTP ${response.status}`);
    }
    body = await response.text();
  } catch (error) {
    if (error instanceof WeatherProviderError) throw error;
    throw new WeatherProviderError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new WeatherProviderError("response was not valid JSON");
  }

  const parsed = openMeteoResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new WeatherProviderError(`unexpected response shape: ${parsed.error.message}`);
  }

  const hour = sliceHour(parsed.data.hourly, hourKey);

  // A missing hour is missing data, not an error: return nulls and let the
  // validation layer raise `weather_missing` and cap confidence.
  if (hour === null) {
    return {
      weatherMode,
      forecastFor: weatherMode === "forecast" ? firstPitch : null,
      temperatureF: null,
      windSpeedMph: null,
      windRelative: null,
      precipitationChance: null,
      roofState,
      fetchedAt,
    };
  }

  const bearing = options.centerFieldBearings?.[park.abbreviation] ?? park.centerFieldBearing;

  // Without a field orientation, a compass bearing cannot be turned into
  // out/in. Report null rather than picking a direction.
  let windRelative: WindRelative | null = null;
  if (bearing !== null && bearing !== undefined && hour.windFromDeg !== null && hour.windSpeedMph !== null) {
    windRelative = deriveWindRelative(hour.windFromDeg, hour.windSpeedMph, bearing);
  }

  return {
    weatherMode,
    forecastFor: weatherMode === "forecast" ? firstPitch : null,
    temperatureF: hour.temperatureF,
    windSpeedMph: hour.windSpeedMph,
    windRelative,
    precipitationChance: hour.precipitationChance,
    roofState,
    fetchedAt,
  };
}
