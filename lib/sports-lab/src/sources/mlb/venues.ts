/**
 * Venue geometry: coordinates for the weather lookup, roof type, and the
 * bearing from home plate to center field so wind direction can be resolved
 * into "blowing out" versus "blowing in".
 *
 * This is fetched from the API rather than hardcoded, on purpose: clubs
 * relocate (the Athletics and Rays both did), and a hardcoded coordinate table
 * would silently pull weather for an empty stadium 2,000 miles away.
 */

import { SOURCE_URLS } from "../../config";
import type { VenueGeo } from "../../core/types";
import type { HttpClient } from "../http";
import { statNumber, venueEnvelopeSchema } from "./parse";

export class MlbVenueSource {
  private readonly cache = new Map<number, VenueGeo | null>();

  constructor(private readonly http: HttpClient) {}

  async geo(venueId: number, fallbackName: string): Promise<VenueGeo | null> {
    if (this.cache.has(venueId)) return this.cache.get(venueId) ?? null;
    if (venueId <= 0) {
      this.cache.set(venueId, null);
      return null;
    }

    const outcome = await this.http.getJson<unknown>(
      `${SOURCE_URLS.mlbStatsApi}/venues/${venueId}`,
      {
        cacheKey: `mlb/venue/${venueId}`,
        // Stadium geometry does not change during a season.
        ttlSeconds: 30 * 24 * 60 * 60,
        label: `MLB venue ${venueId} (${fallbackName})`,
        query: { hydrate: "location,fieldInfo" },
      },
    );

    const parsed = venueEnvelopeSchema.safeParse(outcome.body);
    const node = parsed.success ? parsed.data.venues?.[0] : undefined;
    if (!node) {
      this.cache.set(venueId, null);
      return null;
    }

    const coords = node.location?.defaultCoordinates;
    const geo: VenueGeo = {
      id: node.id ?? venueId,
      name: node.name ?? fallbackName,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      centerFieldBearingDeg: statNumber(node.location?.azimuthAngle),
      roofType: node.fieldInfo?.roofType ?? null,
      elevationFt: statNumber(node.location?.elevation),
    };
    this.cache.set(venueId, geo);
    return geo;
  }
}

/** A venue with no geometry at all — used so the pipeline can still run. */
export function unknownVenue(venueId: number, name: string): VenueGeo {
  return {
    id: venueId,
    name,
    latitude: null,
    longitude: null,
    centerFieldBearingDeg: null,
    roofType: null,
    elevationFt: null,
  };
}
