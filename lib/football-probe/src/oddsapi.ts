import type { CaptureStore } from "./capture";
import { capturedFetch } from "./capture";
import type { Capture } from "./types";

// The Odds API v4 probe. Auth is query-param only on this provider — the
// capture layer redacts the apiKey parameter before anything is persisted,
// and the hard secret-scan refuses to write if the literal key survives.

const BASE = "https://api.the-odds-api.com/v4";
export const EREDIVISIE_KEY = "soccer_netherlands_eredivisie";

export interface OddsApiCaptures {
  captures: Map<string, Capture>;
  notes: string[];
}

export async function probeOddsApi(store: CaptureStore, apiKey: string): Promise<OddsApiCaptures> {
  const captures = new Map<string, Capture>();
  const notes: string[] = [];
  const get = async (name: string, endpoint: string, url: string) => {
    const c = await capturedFetch(store, { provider: "the-odds-api", name, endpoint, url });
    captures.set(name, c);
    return c;
  };

  await get("oa-sports.json", "/sports?all=true", `${BASE}/sports/?apiKey=${apiKey}&all=true`);

  await get(
    "oa-eredivisie-odds.json",
    "/sports/{sport}/odds",
    `${BASE}/sports/${EREDIVISIE_KEY}/odds?apiKey=${apiKey}&regions=eu,uk&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso`,
  );

  // Historical odds live behind a paid plan; a 401/403/422 here is exactly
  // the evidence Phase 0 needs about the CURRENT subscription.
  const snapshotAt = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  notes.push(`historical odds probed at snapshot ${snapshotAt} (7 days ago)`);
  await get(
    "oa-historical-odds.json",
    "/historical/sports/{sport}/odds",
    `${BASE}/historical/sports/${EREDIVISIE_KEY}/odds?apiKey=${apiKey}&regions=eu&markets=h2h&oddsFormat=decimal&date=${snapshotAt}`,
  );

  return { captures, notes };
}
