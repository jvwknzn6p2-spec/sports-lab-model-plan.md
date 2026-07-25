/**
 * Step 3 — Weather.
 *
 * Weather is the source where the observed-vs-forecast distinction becomes
 * real (plan Section 3). Two helpers here:
 *
 *   1. `deriveWindRelative` — converts a compass wind bearing plus the park's
 *      home-plate→center-field orientation into what actually matters for run
 *      scoring: is the wind blowing out, in, across, or calm.
 *   2. `isForecastStale` — for `weatherMode: "forecast"`, checks the forecast
 *      target time against first pitch so a forecast for the wrong hour is
 *      flagged rather than trusted.
 */
import type { Weather, WindRelative } from "../schemas";

/** Below this wind speed, direction is treated as immaterial ("calm"). */
export const CALM_WIND_MPH = 4;

/**
 * Classify wind relative to the field.
 *
 * Meteorological convention: `windFromDeg` is the compass bearing the wind
 * blows *from* (0 = N, 90 = E ...). `parkCenterFieldDeg` is the bearing from
 * home plate toward center field. Wind blowing *toward* center field (i.e.
 * coming from behind home plate) carries balls out; wind coming from center
 * field blows them in.
 *
 * @returns "out" | "in" | "cross" | "calm"
 */
export function deriveWindRelative(
  windFromDeg: number,
  windSpeedMph: number,
  parkCenterFieldDeg: number,
): WindRelative {
  if (windSpeedMph < CALM_WIND_MPH) return "calm";

  // Direction the wind is blowing *toward*.
  const windTowardDeg = (windFromDeg + 180) % 360;

  // Smallest angle between "toward" and the out-to-CF bearing, in [0,180].
  const diff = Math.abs(((windTowardDeg - parkCenterFieldDeg + 540) % 360) - 180);

  if (diff <= 45) return "out"; // blowing out toward center
  if (diff >= 135) return "in"; // blowing in from center
  return "cross";
}

/**
 * Whether a forecast targets a time too far from first pitch to trust.
 * Observed readings are never stale by this measure (they are live).
 *
 * @param toleranceHours Max acceptable gap between `forecastFor` and firstPitch.
 */
export function isForecastStale(
  weather: Pick<Weather, "weatherMode" | "forecastFor">,
  firstPitchISO: string,
  toleranceHours = 3,
): boolean {
  if (weather.weatherMode !== "forecast") return false;
  if (weather.forecastFor === null) return true; // forecast with no target time
  const gapMs = Math.abs(Date.parse(weather.forecastFor) - Date.parse(firstPitchISO));
  return gapMs > toleranceHours * 3_600_000;
}

/** True when the roof takes weather out of play entirely. */
export function roofNeutralizesWeather(weather: Pick<Weather, "roofState">): boolean {
  return weather.roofState === "closed";
}
