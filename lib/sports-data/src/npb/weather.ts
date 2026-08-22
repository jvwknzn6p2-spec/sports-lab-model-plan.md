/**
 * NPB first-pitch weather — the MLB weather builder (sources/weather.ts)
 * pointed at NPB's own 12-park table. Same honesty rules apply verbatim:
 *
 *   - OUTDOOR parks get the bounded temperature multiplier; the high-wind
 *     warn flag fires at ≥30 km/h (extra totals variance).
 *   - DOMES are never adjusted. That includes ベルーナドーム, which is
 *     roofed but open-sided — outside air does reach the field, but no
 *     published coefficient describes a roofed-open-wall park, and applying
 *     the open-air number there would fabricate one. Conservative = 1.0.
 *   - RETRACTABLE roofs (エスコンフィールド, みずほPayPayドーム) are never
 *     adjusted — no feed says whether the roof is open. The reading is
 *     still recorded for the audit trail.
 *   - WIND stays DIRECTION-BLIND for NPB: park orientations come from the
 *     MLB Stats API's venue feed, which has no NPB rows, and typing
 *     bearings in from memory is exactly what the azimuth design refused
 *     to do. cfBearingDeg stays null, so windRunMultiplier returns 1 and
 *     only the high-wind warn flag speaks (see sources/weather.ts).
 *   - A 地方開催 game has venueId null → no coordinates → no weather; the
 *     game runs unadjusted with the usual `[info] weather_missing` flag.
 *
 * Coordinates are the stadium to ~1km (plenty for an hourly forecast).
 * REFERENCE CONSTANTS keyed to the synthetic venue ids in npb/teams.ts —
 * refresh here if a club moves park.
 */

import type { NormalizedGame } from "../mlb/parse";
import {
  buildWeather,
  type VenueSite,
  type WeatherBuildReport,
} from "../sources/weather";

const NPB_SITES: readonly VenueSite[] = [
  { venueId: 9101, lat: 35.706, lon: 139.752, roof: "dome" }, // 東京ドーム
  { venueId: 9102, lat: 34.721, lon: 135.362, roof: "outdoor" }, // 甲子園
  { venueId: 9103, lat: 35.444, lon: 139.64, roof: "outdoor" }, // 横浜スタジアム
  { venueId: 9104, lat: 34.392, lon: 132.484, roof: "outdoor" }, // マツダスタジアム
  { venueId: 9105, lat: 35.674, lon: 139.717, roof: "outdoor" }, // 神宮
  { venueId: 9106, lat: 35.186, lon: 136.947, roof: "dome" }, // バンテリンドーム
  { venueId: 9107, lat: 33.595, lon: 130.362, roof: "retractable" }, // みずほPayPayドーム
  { venueId: 9108, lat: 42.99, lon: 141.55, roof: "retractable" }, // エスコンフィールド
  { venueId: 9109, lat: 35.645, lon: 140.031, roof: "outdoor" }, // ZOZOマリン
  { venueId: 9110, lat: 35.769, lon: 139.42, roof: "dome" }, // ベルーナドーム(開放壁 — see module doc)
  { venueId: 9111, lat: 34.669, lon: 135.476, roof: "dome" }, // 京セラドーム大阪
  { venueId: 9112, lat: 38.256, lon: 140.903, roof: "outdoor" }, // 楽天モバイルパーク宮城
];

const SITE_BY_VENUE: ReadonlyMap<number, VenueSite> = new Map(
  NPB_SITES.map((s) => [s.venueId, s]),
);

export function npbVenueSite(venueId: number | null): VenueSite | undefined {
  return venueId === null ? undefined : SITE_BY_VENUE.get(venueId);
}

/** First-pitch weather for an NPB slate. Fail-soft per venue, like MLB. */
export async function buildNpbWeather(opts: {
  date: string;
  games: NormalizedGame[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<WeatherBuildReport> {
  return buildWeather({
    ...opts,
    siteFor: npbVenueSite,
    fetchAzimuths: false,
  });
}
