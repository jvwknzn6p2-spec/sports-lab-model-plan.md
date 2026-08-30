import type { CaptureStore } from "./capture";
import { capturedFetch } from "./capture";
import type { Capture } from "./types";
import { sportmonksData } from "./extract";

// Sportmonks Football API v3 probe. Every endpoint below is a HYPOTHESIS to
// be tested against the live API — the verdicts come from the captured
// responses, never from this file. Auth goes in the Authorization header so
// recorded URLs stay credential-free by construction.

const BASE = "https://api.sportmonks.com/v3/football";

export interface SportmonksCaptures {
  captures: Map<string, Capture>;
  /** Discovery decisions taken during the run, for the report's audit trail. */
  notes: string[];
}

interface Ids {
  cambuur?: number;
  twente?: number;
  /** A finished head-to-head fixture (evidence for result-dependent items). */
  pastFixture?: number;
  /** The upcoming reference fixture, when the schedule already carries it. */
  upcomingFixture?: number;
}

function firstTeamId(capture: Capture, needle: string, notes: string[]): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture.body);
  } catch {
    return undefined;
  }
  const data = sportmonksData(parsed);
  if (!Array.isArray(data)) return undefined;
  for (const t of data) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const name = typeof rec["name"] === "string" ? rec["name"] : "";
    const id = typeof rec["id"] === "number" ? rec["id"] : undefined;
    if (id !== undefined && name.toLowerCase().includes(needle.toLowerCase())) {
      notes.push(`team search "${needle}" -> picked id=${id} name="${name}" (first name match)`);
      return id;
    }
  }
  return undefined;
}

/** Sportmonks v3 sends "YYYY-MM-DD HH:MM:SS" in UTC; normalize to ISO-8601. */
function parseUtc(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(iso.endsWith("Z") || /[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
}

function pickFixtures(capture: Capture, notes: string[]): Pick<Ids, "pastFixture" | "upcomingFixture"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(capture.body);
  } catch {
    return {};
  }
  const data = sportmonksData(parsed);
  if (!Array.isArray(data)) return {};
  const now = Date.now();
  let past: { id: number; at: number } | undefined;
  let upcoming: { id: number; at: number } | undefined;
  for (const f of data) {
    if (typeof f !== "object" || f === null) continue;
    const rec = f as Record<string, unknown>;
    const id = typeof rec["id"] === "number" ? rec["id"] : undefined;
    const startingAt = typeof rec["starting_at"] === "string" ? parseUtc(rec["starting_at"]) : NaN;
    if (id === undefined || Number.isNaN(startingAt)) continue;
    if (startingAt <= now && (past === undefined || startingAt > past.at)) past = { id, at: startingAt };
    if (startingAt > now && (upcoming === undefined || startingAt < upcoming.at)) upcoming = { id, at: startingAt };
  }
  if (past) notes.push(`head-to-head: latest finished fixture id=${past.id}`);
  if (upcoming) notes.push(`head-to-head: next upcoming fixture id=${upcoming.id} (reference match candidate)`);
  else notes.push("head-to-head: no upcoming Cambuur–Twente fixture in response");
  return { pastFixture: past?.id, upcomingFixture: upcoming?.id };
}

/**
 * Staged discovery: league -> teams -> head-to-head fixtures -> per-item
 * endpoints. Each stage only uses IDs read from real responses of the
 * previous stage; when discovery fails, later captures are simply skipped
 * (their items fall out as UNVERIFIED with the recorded reason).
 */
export async function probeSportmonks(store: CaptureStore, apiKey: string): Promise<SportmonksCaptures> {
  const headers = { Authorization: apiKey };
  const captures = new Map<string, Capture>();
  const notes: string[] = [];
  const get = async (name: string, endpoint: string, url: string) => {
    const c = await capturedFetch(store, { provider: "sportmonks", name, endpoint, url, headers });
    captures.set(name, c);
    return c;
  };

  await get("sm-leagues-search.json", "/leagues/search/{name}", `${BASE}/leagues/search/Eredivisie`);

  const camb = await get("sm-teams-search-cambuur.json", "/teams/search/{name}", `${BASE}/teams/search/Cambuur`);
  const twen = await get("sm-teams-search-twente.json", "/teams/search/{name}", `${BASE}/teams/search/Twente`);
  const ids: Ids = {
    cambuur: firstTeamId(camb, "Cambuur", notes),
    twente: firstTeamId(twen, "Twente", notes),
  };

  if (ids.cambuur !== undefined && ids.twente !== undefined) {
    const h2h = await get(
      "sm-h2h.json",
      "/fixtures/head-to-head/{teamA}/{teamB}",
      `${BASE}/fixtures/head-to-head/${ids.cambuur}/${ids.twente}?include=participants;scores`,
    );
    Object.assign(ids, pickFixtures(h2h, notes));
  } else {
    notes.push("team discovery failed — fixture-level captures skipped");
  }

  // Result-dependent items need a FINISHED fixture; lineups/stats/xG only
  // exist after a match has been played.
  if (ids.pastFixture !== undefined) {
    await get(
      "sm-fixture-detail.json",
      "/fixtures/{id}?include=lineups;formations;statistics;events;scores;participants",
      `${BASE}/fixtures/${ids.pastFixture}?include=lineups;formations;statistics;events;scores;participants`,
    );
    await get(
      "sm-fixture-xg.json",
      "/fixtures/{id}?include=xGFixture",
      `${BASE}/fixtures/${ids.pastFixture}?include=xGFixture`,
    );
  }

  // Odds are quoted on upcoming fixtures; fall back to the finished one so a
  // plan-level denial (403) still gets captured even without a scheduled match.
  const oddsFixture = ids.upcomingFixture ?? ids.pastFixture;
  if (oddsFixture !== undefined) {
    await get(
      "sm-odds-prematch.json",
      "/odds/pre-match/fixtures/{id}",
      `${BASE}/odds/pre-match/fixtures/${oddsFixture}`,
    );
  }

  if (ids.cambuur !== undefined) {
    await get("sm-squad.json", "/squads/teams/{id}", `${BASE}/squads/teams/${ids.cambuur}?include=player`);
    await get(
      "sm-sidelined.json",
      "/teams/{id}?include=sidelined",
      `${BASE}/teams/${ids.cambuur}?include=sidelined`,
    );
  }

  return { captures, notes };
}
