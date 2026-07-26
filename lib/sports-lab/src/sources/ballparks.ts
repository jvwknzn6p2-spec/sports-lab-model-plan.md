/**
 * Ballpark geography — coordinates, roof type, and field orientation.
 *
 * Needed by the weather provider: a forecast is a point query, so every park
 * needs a latitude/longitude, and turning a compass wind bearing into
 * "blowing out" or "blowing in" needs to know which way the field points.
 *
 * **On the two kinds of value here.** Coordinates and roof type are public,
 * categorical facts and are populated. Field orientation is a *measured*
 * bearing, and this table ships it as `null` — see
 * {@link BallparkGeo.centerFieldBearing}. Publishing a guessed bearing would
 * be exactly the silent-wrong-number this project is built to avoid: a bearing
 * wrong by 90° flips "wind out" into "crosswind" and quietly moves every total.
 * Until measured values are supplied, wind direction stays unmodeled and the
 * temperature effect still applies.
 */

/** How a park's roof behaves. */
export type RoofType =
  /** No roof — weather always applies. */
  | "open"
  /** Retractable — open or closed depending on the day. */
  | "retractable"
  /** Permanently enclosed — weather never applies. */
  | "fixed";

export interface BallparkGeo {
  /** Home-team abbreviation, matching the park-factor table. */
  abbreviation: string;
  name: string;
  latitude: number;
  longitude: number;
  roofType: RoofType;
  /**
   * Compass bearing from home plate toward center field, in degrees from
   * north — the input `deriveWindRelative` needs.
   *
   * **Null throughout this table by design.** These are measured values; this
   * library does not have a citable source for them, and a fabricated bearing
   * would silently mis-sign the wind adjustment. Supply them via
   * `weatherProviderOptions.centerFieldBearings` once you have a source you
   * trust (they can be measured off satellite imagery, or taken from a
   * published stadium-orientation table).
   *
   * While null, `windRelative` is reported as null, the baseline skips its
   * wind adjustment, and temperature still applies.
   */
  centerFieldBearing: number | null;
}

/**
 * The 30 MLB parks, keyed by home-team abbreviation.
 *
 * Coordinates are to roughly the nearest ~100m, which is far finer than a
 * weather forecast's own grid resolution.
 */
const BALLPARKS: readonly BallparkGeo[] = [
  { abbreviation: "ARI", name: "Chase Field", latitude: 33.4455, longitude: -112.0667, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "ATL", name: "Truist Park", latitude: 33.8907, longitude: -84.4677, roofType: "open", centerFieldBearing: null },
  { abbreviation: "BAL", name: "Oriole Park at Camden Yards", latitude: 39.2839, longitude: -76.6217, roofType: "open", centerFieldBearing: null },
  { abbreviation: "BOS", name: "Fenway Park", latitude: 42.3467, longitude: -71.0972, roofType: "open", centerFieldBearing: null },
  { abbreviation: "CHC", name: "Wrigley Field", latitude: 41.9484, longitude: -87.6553, roofType: "open", centerFieldBearing: null },
  { abbreviation: "CWS", name: "Rate Field", latitude: 41.8299, longitude: -87.6338, roofType: "open", centerFieldBearing: null },
  { abbreviation: "CIN", name: "Great American Ball Park", latitude: 39.0975, longitude: -84.5069, roofType: "open", centerFieldBearing: null },
  { abbreviation: "CLE", name: "Progressive Field", latitude: 41.4962, longitude: -81.6852, roofType: "open", centerFieldBearing: null },
  { abbreviation: "COL", name: "Coors Field", latitude: 39.7559, longitude: -104.9942, roofType: "open", centerFieldBearing: null },
  { abbreviation: "DET", name: "Comerica Park", latitude: 42.339, longitude: -83.0485, roofType: "open", centerFieldBearing: null },
  { abbreviation: "HOU", name: "Daikin Park", latitude: 29.7572, longitude: -95.3552, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "KC", name: "Kauffman Stadium", latitude: 39.0517, longitude: -94.4803, roofType: "open", centerFieldBearing: null },
  { abbreviation: "LAA", name: "Angel Stadium", latitude: 33.8003, longitude: -117.8827, roofType: "open", centerFieldBearing: null },
  { abbreviation: "LAD", name: "Dodger Stadium", latitude: 34.0739, longitude: -118.24, roofType: "open", centerFieldBearing: null },
  { abbreviation: "MIA", name: "loanDepot park", latitude: 25.7781, longitude: -80.2197, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "MIL", name: "American Family Field", latitude: 43.028, longitude: -87.9712, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "MIN", name: "Target Field", latitude: 44.9817, longitude: -93.2776, roofType: "open", centerFieldBearing: null },
  { abbreviation: "NYM", name: "Citi Field", latitude: 40.7571, longitude: -73.8458, roofType: "open", centerFieldBearing: null },
  { abbreviation: "NYY", name: "Yankee Stadium", latitude: 40.8296, longitude: -73.9262, roofType: "open", centerFieldBearing: null },
  { abbreviation: "OAK", name: "Sutter Health Park", latitude: 38.5802, longitude: -121.5133, roofType: "open", centerFieldBearing: null },
  { abbreviation: "PHI", name: "Citizens Bank Park", latitude: 39.9061, longitude: -75.1665, roofType: "open", centerFieldBearing: null },
  { abbreviation: "PIT", name: "PNC Park", latitude: 40.4469, longitude: -80.0057, roofType: "open", centerFieldBearing: null },
  { abbreviation: "SD", name: "Petco Park", latitude: 32.7076, longitude: -117.157, roofType: "open", centerFieldBearing: null },
  { abbreviation: "SF", name: "Oracle Park", latitude: 37.7786, longitude: -122.3893, roofType: "open", centerFieldBearing: null },
  { abbreviation: "SEA", name: "T-Mobile Park", latitude: 47.5914, longitude: -122.3325, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "STL", name: "Busch Stadium", latitude: 38.6226, longitude: -90.1928, roofType: "open", centerFieldBearing: null },
  { abbreviation: "TB", name: "Tropicana Field", latitude: 27.7683, longitude: -82.6534, roofType: "fixed", centerFieldBearing: null },
  { abbreviation: "TEX", name: "Globe Life Field", latitude: 32.7473, longitude: -97.0847, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "TOR", name: "Rogers Centre", latitude: 43.6414, longitude: -79.3894, roofType: "retractable", centerFieldBearing: null },
  { abbreviation: "WSH", name: "Nationals Park", latitude: 38.873, longitude: -77.0074, roofType: "open", centerFieldBearing: null },
];

const BY_ABBREVIATION = new Map(BALLPARKS.map((park) => [park.abbreviation, park]));

/** Look up a park by home-team abbreviation. Null when unknown. */
export function lookupBallparkGeo(abbreviation: string): BallparkGeo | null {
  return BY_ABBREVIATION.get(abbreviation.toUpperCase()) ?? null;
}

/** Every park in the table. */
export function allBallparkGeo(): readonly BallparkGeo[] {
  return BALLPARKS;
}

export const BALLPARK_GEO_COUNT = BALLPARKS.length;
