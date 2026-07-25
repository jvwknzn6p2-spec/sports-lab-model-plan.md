/**
 * First-pitch weather from Open-Meteo (no API key required).
 *
 * We ask for the hourly series covering the game date and pick the hour nearest
 * first pitch. Roofed parks still get a lookup — a retractable roof is usually
 * open in good weather — but a fixed dome short-circuits to "roof closed" and
 * the weather adjustment is skipped entirely.
 */

import { SOURCE_URLS } from "../config";
import type { GameDate, VenueGeo, WeatherObs } from "../core/types";
import type { HttpClient } from "./http";

const HOURLY_FIELDS = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_direction_10m",
] as const;

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    relative_humidity_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
  };
}

/** Fixed domes: the roof is never open, so outside conditions do not matter. */
function isFixedDome(roofType: string | null): boolean {
  if (!roofType) return false;
  const normalised = roofType.toLowerCase();
  return normalised === "dome" || normalised === "indoor" || normalised === "fixed";
}

function nearestHourIndex(times: string[], targetIso: string): number | null {
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return null;
  let bestIndex: number | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(`${times[i]}Z`);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  // More than 3 hours from any sample means the series does not cover the game.
  if (bestIndex === null || bestDelta > 3 * 3_600_000) return null;
  return bestIndex;
}

export class WeatherSource {
  constructor(private readonly http: HttpClient) {}

  async forGame(
    venue: VenueGeo,
    date: GameDate,
    gameTimeUtc: string,
  ): Promise<WeatherObs | null> {
    if (isFixedDome(venue.roofType)) {
      return {
        temperatureF: null,
        windMph: null,
        windFromDeg: null,
        precipitationProbability: null,
        humidityPct: null,
        roofClosed: true,
        source: "fixed dome (no weather lookup needed)",
        fetchedAt: new Date().toISOString(),
      };
    }
    if (venue.latitude === null || venue.longitude === null) return null;

    const outcome = await this.http.getJson<OpenMeteoResponse>(SOURCE_URLS.openMeteo, {
      cacheKey: `weather/${venue.id}-${date}`,
      label: `Open-Meteo forecast for ${venue.name} on ${date}`,
      ttlSeconds: 60 * 60,
      query: {
        latitude: venue.latitude,
        longitude: venue.longitude,
        hourly: HOURLY_FIELDS.join(","),
        temperature_unit: "fahrenheit",
        wind_speed_unit: "mph",
        precipitation_unit: "inch",
        timezone: "UTC",
        start_date: date,
        end_date: date,
      },
    });

    const hourly = outcome.body.hourly;
    if (!hourly?.time || hourly.time.length === 0) return null;
    const idx = nearestHourIndex(hourly.time, gameTimeUtc);
    if (idx === null) return null;

    const pick = (series: (number | null)[] | undefined): number | null => {
      const value = series?.[idx];
      return value === null || value === undefined || !Number.isFinite(value) ? null : value;
    };

    return {
      temperatureF: pick(hourly.temperature_2m),
      windMph: pick(hourly.wind_speed_10m),
      windFromDeg: pick(hourly.wind_direction_10m),
      precipitationProbability: pick(hourly.precipitation_probability),
      humidityPct: pick(hourly.relative_humidity_2m),
      roofClosed: false,
      source: "open-meteo",
      fetchedAt: outcome.fetchedAt,
    };
  }
}
