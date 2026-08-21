/**
 * Game-time weather per ballpark, from the Open-Meteo forecast API
 * (https://open-meteo.com — free, no API key, fine for ~15 calls a day).
 *
 * What the model does with it (run-model.ts):
 *   - OUTDOOR parks: a bounded temperature multiplier on both teams'
 *     expected runs. Run scoring rises with air temperature (carry + livelier
 *     offense); the published effect is roughly +2–2.5% runs per 10°F, i.e.
 *     ~0.7% per °C. Applied symmetrically around a 21°C (70°F) baseline and
 *     clamped hard — weather nudges a mean, it never dominates it.
 *   - DOMES: no adjustment, ever.
 *   - RETRACTABLE roofs: no adjustment — whether the roof is open is not in
 *     any feed we pull, and guessing it would fabricate an input. The
 *     temperature is still recorded for the audit trail.
 *   - High wind at an outdoor park raises a warn flag only. Without park
 *     orientation data, wind direction cannot be translated into a run
 *     effect honestly; a flag says "totals are less certain today" without
 *     inventing a number.
 *
 * Failure policy: fail-soft per venue. A fetch error leaves that game's
 * weather null (an `[info] weather_missing` flag downstream), never a guess.
 */

import type { NormalizedGame } from "../mlb/parse";

export type RoofType = "outdoor" | "dome" | "retractable";

export interface GameWeather {
  /** Air temperature (°C) at the hour nearest first pitch. */
  temperatureC: number | null;
  /** Wind speed (km/h, 10m) at the hour nearest first pitch. */
  windSpeedKmh: number | null;
  roof: RoofType;
  fetchedAt?: string;
}

interface VenueSite {
  readonly venueId: number;
  readonly lat: number;
  readonly lon: number;
  readonly roof: RoofType;
}

/**
 * The 30 parks, same venue ids as park-factors.ts. Coordinates are the
 * stadium to ~1km — plenty for an hourly forecast. REFERENCE CONSTANTS:
 * refresh alongside the park-factor table when a team moves.
 */
const SITES: readonly VenueSite[] = [
  { venueId: 19, lat: 39.756, lon: -104.994, roof: "outdoor" }, // Coors
  { venueId: 3, lat: 42.346, lon: -71.097, roof: "outdoor" }, // Fenway
  { venueId: 2602, lat: 39.097, lon: -84.507, roof: "outdoor" }, // GABP
  { venueId: 15, lat: 33.445, lon: -112.067, roof: "retractable" }, // Chase
  { venueId: 7, lat: 39.051, lon: -94.48, roof: "outdoor" }, // Kauffman
  { venueId: 3313, lat: 40.829, lon: -73.926, roof: "outdoor" }, // Yankee
  { venueId: 2681, lat: 39.906, lon: -75.166, roof: "outdoor" }, // CBP
  { venueId: 4705, lat: 33.891, lon: -84.468, roof: "outdoor" }, // Truist
  { venueId: 3309, lat: 38.873, lon: -77.007, roof: "outdoor" }, // Nationals
  { venueId: 14, lat: 43.641, lon: -79.389, roof: "retractable" }, // Rogers
  { venueId: 4, lat: 41.83, lon: -87.634, roof: "outdoor" }, // Rate Field
  { venueId: 32, lat: 43.028, lon: -87.971, roof: "retractable" }, // AmFam
  { venueId: 17, lat: 41.948, lon: -87.655, roof: "outdoor" }, // Wrigley
  { venueId: 1, lat: 33.8, lon: -117.883, roof: "outdoor" }, // Angel
  { venueId: 22, lat: 34.074, lon: -118.24, roof: "outdoor" }, // Dodger
  { venueId: 2392, lat: 29.757, lon: -95.356, roof: "retractable" }, // Daikin
  { venueId: 3312, lat: 44.982, lon: -93.278, roof: "outdoor" }, // Target
  { venueId: 5325, lat: 32.747, lon: -97.084, roof: "retractable" }, // Globe Life
  { venueId: 2, lat: 39.284, lon: -76.622, roof: "outdoor" }, // Camden
  { venueId: 5, lat: 41.496, lon: -81.685, roof: "outdoor" }, // Progressive
  { venueId: 2394, lat: 42.339, lon: -83.049, roof: "outdoor" }, // Comerica
  { venueId: 31, lat: 40.447, lon: -80.006, roof: "outdoor" }, // PNC
  { venueId: 2889, lat: 38.623, lon: -90.193, roof: "outdoor" }, // Busch
  { venueId: 4169, lat: 25.778, lon: -80.22, roof: "retractable" }, // loanDepot
  { venueId: 3289, lat: 40.757, lon: -73.846, roof: "outdoor" }, // Citi
  { venueId: 12, lat: 27.768, lon: -82.653, roof: "dome" }, // Tropicana
  { venueId: 2680, lat: 32.708, lon: -117.157, roof: "outdoor" }, // Petco
  { venueId: 10, lat: 37.752, lon: -122.201, roof: "outdoor" }, // Coliseum
  { venueId: 2395, lat: 37.778, lon: -122.389, roof: "outdoor" }, // Oracle
  { venueId: 680, lat: 47.591, lon: -122.333, roof: "retractable" }, // T-Mobile
];

const SITE_BY_VENUE: ReadonlyMap<number, VenueSite> = new Map(
  SITES.map((s) => [s.venueId, s]),
);

export function getVenueSite(venueId: number | null): VenueSite | undefined {
  return venueId === null ? undefined : SITE_BY_VENUE.get(venueId);
}

/** °C above which (and below which) run scoring adjusts. 21°C ≈ 70°F. */
export const TEMP_BASELINE_C = 21;
/** Run-environment change per °C away from the baseline (~+2.3%/10°F). */
export const TEMP_RUNS_PER_DEG_C = 0.007;
/** Hard clamp on the multiplier — weather nudges, never dominates. */
export const TEMP_MULT_MIN = 0.94;
export const TEMP_MULT_MAX = 1.06;
/** Outdoor wind at/above this speed flags the game (no numeric adjustment). */
export const HIGH_WIND_KMH = 30;

/**
 * Temperature multiplier on expected runs. 1.0 whenever an honest number is
 * impossible: no reading, a dome, or a retractable roof of unknown state.
 */
export function temperatureRunMultiplier(w: GameWeather | null): number {
  if (!w || w.roof !== "outdoor" || w.temperatureC === null) return 1;
  const raw = 1 + (w.temperatureC - TEMP_BASELINE_C) * TEMP_RUNS_PER_DEG_C;
  return Math.min(TEMP_MULT_MAX, Math.max(TEMP_MULT_MIN, raw));
}

/** The subset of the Open-Meteo hourly forecast payload this module reads. */
export interface OpenMeteoHourly {
  hourly: {
    time: string[];
    temperature_2m: Array<number | null>;
    wind_speed_10m: Array<number | null>;
  };
}

/** Pick the forecast hour nearest to first pitch. */
export function weatherAtFirstPitch(
  payload: OpenMeteoHourly,
  gameDateIso: string,
  roof: RoofType,
): GameWeather {
  const target = Date.parse(gameDateIso);
  const times = payload.hourly.time;
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns bare "YYYY-MM-DDTHH:00" stamps for timezone=UTC.
    const t = Date.parse(
      times[i]!.endsWith("Z") ? times[i]! : `${times[i]}Z`,
    );
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return {
    temperatureC: best >= 0 ? (payload.hourly.temperature_2m[best] ?? null) : null,
    windSpeedKmh: best >= 0 ? (payload.hourly.wind_speed_10m[best] ?? null) : null,
    roof,
  };
}

export interface WeatherBuildReport {
  /** Keyed by stringified gamePk. */
  weather: Record<string, GameWeather>;
  warnings: string[];
}

/**
 * Fetch first-pitch weather for a slate. One Open-Meteo call per unique
 * venue; a failed venue is warned and skipped (its games stay weatherless).
 */
export async function buildWeather(opts: {
  date: string;
  games: NormalizedGame[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WeatherBuildReport> {
  const doFetch = opts.fetchImpl ?? fetch;
  const warnings: string[] = [];
  const weather: Record<string, GameWeather> = {};
  const byVenue = new Map<number, OpenMeteoHourly | null>();

  for (const g of opts.games) {
    const site = getVenueSite(g.venue.id);
    if (!site) {
      warnings.push(
        `game ${g.gamePk}: unknown venue ${g.venue.id ?? "?"} (${g.venue.name ?? "?"}) — no weather`,
      );
      continue;
    }
    // Domes never need a forecast; record the roof so the report can say so.
    if (site.roof === "dome") {
      weather[String(g.gamePk)] = {
        temperatureC: null,
        windSpeedKmh: null,
        roof: "dome",
      };
      continue;
    }
    if (!byVenue.has(site.venueId)) {
      const url =
        "https://api.open-meteo.com/v1/forecast" +
        `?latitude=${site.lat}&longitude=${site.lon}` +
        "&hourly=temperature_2m,wind_speed_10m" +
        `&start_date=${opts.date}&end_date=${opts.date}&timezone=UTC`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      try {
        const res = await doFetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        byVenue.set(site.venueId, (await res.json()) as OpenMeteoHourly);
      } catch (err) {
        warnings.push(
          `venue ${site.venueId}: weather fetch failed (${err instanceof Error ? err.message : String(err)})`,
        );
        byVenue.set(site.venueId, null);
      } finally {
        clearTimeout(timer);
      }
    }
    const payload = byVenue.get(site.venueId);
    if (!payload || !g.gameDate) continue;
    weather[String(g.gamePk)] = {
      ...weatherAtFirstPitch(payload, g.gameDate, site.roof),
      fetchedAt: new Date().toISOString(),
    };
  }
  return { weather, warnings };
}
