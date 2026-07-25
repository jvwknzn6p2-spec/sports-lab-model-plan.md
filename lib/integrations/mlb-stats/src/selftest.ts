/**
 * Self-checking test suite. Run with `pnpm --filter @workspace/mlb-stats run test`.
 *
 * Everything here runs offline. `fetch` and `sleep` are injected, so retry and
 * timeout behaviour is exercised for real without waiting or reaching the
 * network, and the parsing path is driven by fixtures shaped like genuine API
 * responses.
 */

import { MlbApiError, requestJson } from "./client.ts";
import * as fixtures from "./fixtures.ts";
import { normalizeGame, normalizeGameType, normalizeStatus, seedForGame } from "./normalize.ts";
import { fetchSchedule, fetchScheduleRange, parseSchedule } from "./schedule.ts";
import { teamAbbreviation } from "./teams.ts";
import type { ScheduledGame } from "./types.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const noSleep = async (): Promise<void> => {};
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FETCHED_AT = "2026-07-25T09:00:00.000Z";
const snapshot = parseSchedule(fixtures.scheduleResponse, "2026-07-25", FETCHED_AT);
const byPk = (gamePk: number): ScheduledGame => {
  const game = snapshot.games.find((candidate) => candidate.gamePk === gamePk);
  if (!game) throw new Error(`fixture game ${gamePk} missing from snapshot`);
  return game;
};

// ---------------------------------------------------------------------------
section("Status normalisation");
// ---------------------------------------------------------------------------
{
  equal("Scheduled maps to scheduled", normalizeStatus("Scheduled", "Preview"), "scheduled");
  equal("Pre-Game maps to pregame", normalizeStatus("Pre-Game", "Preview"), "pregame");
  equal("Warmup maps to pregame", normalizeStatus("Warmup", "Preview"), "pregame");
  equal("In Progress maps to live", normalizeStatus("In Progress", "Live"), "live");
  equal("Final maps to final", normalizeStatus("Final", "Final"), "final");
  equal("Game Over maps to final", normalizeStatus("Game Over", "Final"), "final");

  // The important ones: a postponement still reports "Preview", so reading
  // abstractGameState alone would treat a rained-out game as playable.
  equal("Postponed is detected", normalizeStatus("Postponed", "Preview"), "postponed");
  equal("Cancelled is detected", normalizeStatus("Cancelled", "Preview"), "cancelled");
  equal("Suspended is detected", normalizeStatus("Suspended: Rain", "Live"), "suspended");
  equal("Delayed is detected", normalizeStatus("Delayed Start: Rain", "Preview"), "delayed");
  equal("Forfeits count as final", normalizeStatus("Forfeit", "Final"), "final");
  equal("Unknown states are marked unknown", normalizeStatus("Something New", "Other"), "unknown");

  equal("regular season", normalizeGameType("R"), "regular");
  equal("spring training", normalizeGameType("S"), "spring");
  equal("world series", normalizeGameType("W"), "postseason");
  equal("division series", normalizeGameType("D"), "postseason");
  equal("wild card", normalizeGameType("F"), "postseason");
  equal("all-star", normalizeGameType("A"), "allstar");
  equal("exhibition", normalizeGameType("E"), "exhibition");
  equal("unknown code", normalizeGameType("Z"), "other");
  equal("codes are case-insensitive", normalizeGameType("r"), "regular");
}

// ---------------------------------------------------------------------------
section("Team abbreviations");
// ---------------------------------------------------------------------------
{
  equal("known team by id", teamAbbreviation(117, "Houston Astros"), "HOU");
  equal("id wins over name", teamAbbreviation(133, "Athletics"), "ATH");
  // A rebrand changes the name but never the id, so the mapping must key on id.
  equal("rebranded team keeps its id mapping", teamAbbreviation(114, "Cleveland Indians"), "CLE");
  equal("unknown multi-word team", teamAbbreviation(9999, "Tokyo Yomiuri Giants"), "TYG");
  equal("unknown single-word team", teamAbbreviation(9999, "Samurais"), "SAM");
  equal("unnamed team falls back to id", teamAbbreviation(4242, ""), "T4242");
}

// ---------------------------------------------------------------------------
section("Parsing a full day");
// ---------------------------------------------------------------------------
{
  equal("all games are parsed", snapshot.games.length, 6);
  equal("the date is carried through", snapshot.date, "2026-07-25");
  equal("the fetch time is recorded", snapshot.fetchedAt, FETCHED_AT);

  // The API does not guarantee order; a stable sort keeps stored snapshots
  // diffable from one run to the next.
  const times = snapshot.games.map((game) => game.startTime);
  check(
    "games are sorted by start time",
    times.every((time, i) => i === 0 || times[i - 1] <= time),
    times.join(" "),
  );

  equal("predictable games are counted", snapshot.counts.predictable, 4);
  equal("postponements are counted", snapshot.counts.postponed, 1);
  equal("games missing a starter are counted", snapshot.counts.missingPitchers, 2);
  equal("total matches the game count", snapshot.counts.total, 6);

  const empty = parseSchedule(fixtures.emptyScheduleResponse, "2026-12-25", FETCHED_AT);
  equal("an off day parses to zero games", empty.games.length, 0);
  equal("an off day is not an error", empty.counts.total, 0);
}

// ---------------------------------------------------------------------------
section("Normal game");
// ---------------------------------------------------------------------------
{
  const game = byPk(776529);
  equal("key is readable and dated", game.key, "2026-07-25:LAA@HOU:g1");
  equal("seed is derived from gamePk", game.seed, "mlb:776529");
  equal("home team is identified", game.home.name, "Houston Astros");
  equal("away team is identified", game.away.name, "Los Angeles Angels");
  equal("home starter is captured", game.home.probablePitcher?.fullName, "Framber Valdez");
  equal("away starter is captured", game.away.probablePitcher?.fullName, "Reid Detmers");
  equal("records are captured", game.home.wins, 62);
  equal("venue is captured", game.venue?.name, "Daikin Park");
  equal("start time is preserved as UTC", game.startTime, "2026-07-25T23:10:00Z");
  equal("day/night is captured", game.dayNight, "night");
  check("a complete game is predictable", game.isPredictable);
  check("a complete game has no flags", game.flags.length === 0, game.flags.join(","));
  equal("score is null before the game", game.home.score, null);
}

// ---------------------------------------------------------------------------
section("Doubleheaders");
// ---------------------------------------------------------------------------
{
  const first = byPk(776530);
  const second = byPk(776531);

  // The bug this guards against: deriving a seed from teams and date gives both
  // halves of a doubleheader the same random stream, so the two games would be
  // simulated identically. gamePk is unique per game, so they cannot collide.
  check("the two games have different seeds", first.seed !== second.seed);
  check("the two games have different keys", first.key !== second.key);
  equal("game one is numbered", first.key, "2026-07-25:NYY@BOS:g1");
  equal("game two is numbered", second.key, "2026-07-25:NYY@BOS:g2");
  check("both are flagged as a doubleheader", first.flags.includes("doubleheader"));
  equal("split doubleheaders are identified", first.doubleHeader, "split");
  equal("game numbers are preserved", second.gameNumber, 2);

  check("both games are predictable", first.isPredictable && second.isPredictable);
  check(
    "the unannounced starter in game two is flagged",
    second.flags.includes("missing-home-pitcher") &&
      second.flags.includes("missing-away-pitcher"),
  );
  // Flagged, not filled in. The plan's rule is to surface the gap, not paper
  // over it with a league average.
  equal("the missing starter stays null", second.home.probablePitcher, null);
  check("missing data does not block prediction", second.isPredictable);

  const seeds = new Set(snapshot.games.map((game) => game.seed));
  equal("every game in the day has a unique seed", seeds.size, snapshot.games.length);
}

// ---------------------------------------------------------------------------
section("Postponed, completed, and TBD games");
// ---------------------------------------------------------------------------
{
  const postponed = byPk(776532);
  equal("postponed status is normalised", postponed.status, "postponed");
  check("a postponed game is not predictable", !postponed.isPredictable);
  check("a postponed game is flagged", postponed.flags.includes("postponed"));
  equal("the reason is captured", postponed.statusReason, "Rain");
  // Starters were announced before the rainout; we keep them rather than
  // discarding data that will still be true when the game is made up.
  equal("announced starters survive a postponement", postponed.home.probablePitcher?.fullName, "Sean Manaea");

  const completed = byPk(776534);
  equal("final status is normalised", completed.status, "final");
  check("a finished game is not predictable", !completed.isPredictable);
  check("a finished game is flagged", completed.flags.includes("completed"));
  equal("the home score is captured", completed.home.score, 5);
  equal("the away score is captured", completed.away.score, 3);

  const tbd = byPk(776533);
  check("a TBD start is flagged", tbd.flags.includes("start-time-tbd"));
  check("a TBD game is still predictable", tbd.isPredictable);

  // Venue drives the park factors in §4.1, so its absence has to be visible
  // rather than defaulting to some neutral stadium.
  const { venue: _removed, ...noVenue } = fixtures.normalGame;
  const venueless = normalizeGame(noVenue);
  equal("a missing venue stays null", venueless.venue, null);
  check("a missing venue is flagged", venueless.flags.includes("missing-venue"));

  // officialDate is occasionally absent; the UTC date is the documented
  // fallback and must not silently produce an empty string.
  const { officialDate: _dropped, ...noDate } = fixtures.normalGame;
  const derived = normalizeGame(noDate);
  equal("officialDate falls back to the UTC date", derived.officialDate, "2026-07-25");
}

// ---------------------------------------------------------------------------
section("Non-regular-season games");
// ---------------------------------------------------------------------------
{
  const spring = normalizeGame(fixtures.springTrainingGame);
  equal("spring training is identified", spring.gameType, "spring");
  check("spring training is flagged", spring.flags.includes("non-regular-season"));
  // Flagged rather than dropped: the caller decides. Silently including spring
  // training in a regular-season backtest would corrupt the results.
  check("the caller decides whether to use it", spring.isPredictable);
}

// ---------------------------------------------------------------------------
section("Validation");
// ---------------------------------------------------------------------------
{
  let error: unknown = null;
  try {
    parseSchedule(fixtures.malformedScheduleResponse, "2026-07-25", FETCHED_AT);
  } catch (caught) {
    error = caught;
  }
  check("a missing required field is rejected", error instanceof MlbApiError);
  check(
    "the error names the offending field",
    error instanceof MlbApiError && error.message.includes("gamePk"),
    error instanceof Error ? error.message : String(error),
  );
  equal(
    "the error is classified",
    error instanceof MlbApiError ? error.kind : null,
    "invalid-response",
  );

  // Unknown fields must NOT be rejected — MLB adds them regularly and a morning
  // run should not fail because of a new key.
  const withExtras = {
    dates: [
      {
        date: "2026-07-25",
        games: [{ ...fixtures.normalGame, someNewFieldMlbAdded: true, anotherOne: { a: 1 } }],
      },
    ],
    unexpectedTopLevel: "ignored",
  };
  const tolerant = parseSchedule(withExtras, "2026-07-25", FETCHED_AT);
  equal("unknown fields are ignored, not rejected", tolerant.games.length, 1);

  for (const bad of ["2026-7-25", "25-07-2026", "not-a-date", "2026-02-30", ""]) {
    let threw = false;
    try {
      await fetchSchedule(bad, { fetch: async () => jsonResponse(fixtures.emptyScheduleResponse) });
    } catch {
      threw = true;
    }
    check(`"${bad}" is rejected as a date`, threw);
  }
}

// ---------------------------------------------------------------------------
section("HTTP client — retries and errors");
// ---------------------------------------------------------------------------
{
  let calls = 0;
  const flaky: typeof globalThis.fetch = async () => {
    calls++;
    if (calls < 3) return jsonResponse({ error: "upstream" }, 503);
    return jsonResponse(fixtures.emptyScheduleResponse);
  };
  const recovered = await requestJson("schedule", {}, { fetch: flaky, sleep: noSleep });
  equal("a 503 is retried until it succeeds", calls, 3);
  check("the eventual response is returned", recovered !== null);

  calls = 0;
  const notFound: typeof globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ message: "Not Found" }, 404);
  };
  let error: unknown = null;
  try {
    await requestJson("schedule", {}, { fetch: notFound, sleep: noSleep });
  } catch (caught) {
    error = caught;
  }
  // A 404 means our request was wrong. Retrying it four times just delays the
  // error by the full backoff.
  equal("a 404 is not retried", calls, 1);
  equal("a 404 is classified as http", error instanceof MlbApiError ? error.kind : null, "http");
  equal("the status is preserved", error instanceof MlbApiError ? error.status : null, 404);

  calls = 0;
  const rateLimited: typeof globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ message: "Too Many Requests" }, 429);
  };
  try {
    await requestJson("schedule", {}, { fetch: rateLimited, sleep: noSleep, retries: 2 });
  } catch {
    /* expected */
  }
  equal("a 429 is retried", calls, 3);

  calls = 0;
  const offline: typeof globalThis.fetch = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };
  error = null;
  try {
    await requestJson("schedule", {}, { fetch: offline, sleep: noSleep, retries: 2 });
  } catch (caught) {
    error = caught;
  }
  equal("network errors are retried", calls, 3);
  equal(
    "network errors are classified",
    error instanceof MlbApiError ? error.kind : null,
    "network",
  );
  equal("the attempt count is reported", error instanceof MlbApiError ? error.attempts : 0, 3);

  const timingOut: typeof globalThis.fetch = async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    throw timeout;
  };
  error = null;
  try {
    await requestJson("schedule", {}, { fetch: timingOut, sleep: noSleep, retries: 1 });
  } catch (caught) {
    error = caught;
  }
  equal(
    "timeouts are classified separately",
    error instanceof MlbApiError ? error.kind : null,
    "timeout",
  );

  calls = 0;
  const badJson: typeof globalThis.fetch = async () => {
    calls++;
    return new Response("<html>maintenance</html>", { status: 200 });
  };
  error = null;
  try {
    await requestJson("schedule", {}, { fetch: badJson, sleep: noSleep, retries: 3 });
  } catch (caught) {
    error = caught;
  }
  // A 200 carrying HTML will keep carrying HTML; retrying wastes the backoff.
  equal("malformed JSON is not retried", calls, 1);
  equal(
    "malformed JSON is classified",
    error instanceof MlbApiError ? error.kind : null,
    "invalid-response",
  );
}

// ---------------------------------------------------------------------------
section("Request construction");
// ---------------------------------------------------------------------------
{
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const capturing: typeof globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    return jsonResponse(fixtures.emptyScheduleResponse);
  };

  await fetchSchedule("2026-07-25", { fetch: capturing, sleep: noSleep });
  check("sportId=1 selects MLB", capturedUrl.includes("sportId=1"), capturedUrl);
  check("the date is sent", capturedUrl.includes("date=2026-07-25"), capturedUrl);
  // Without this hydration the schedule comes back with no pitcher at all,
  // which would silently strip the model's most important input.
  check(
    "probablePitcher is hydrated by default",
    capturedUrl.includes("hydrate=probablePitcher"),
    capturedUrl,
  );
  check("a user agent is sent", "user-agent" in capturedHeaders);

  await fetchSchedule("2026-07-25", {
    fetch: capturing,
    sleep: noSleep,
    hydrate: ["probablePitcher", "linescore"],
  });
  check(
    "extra hydrations are joined",
    capturedUrl.includes("hydrate=probablePitcher%2Clinescore"),
    capturedUrl,
  );

  await fetchSchedule("2026-07-25", { fetch: capturing, sleep: noSleep, hydrate: [] });
  check("hydration can be disabled", !capturedUrl.includes("hydrate="), capturedUrl);
}

// ---------------------------------------------------------------------------
section("Date ranges (backfill for backtesting)");
// ---------------------------------------------------------------------------
{
  let capturedUrl = "";
  const capturing: typeof globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return jsonResponse(fixtures.rangeScheduleResponse);
  };

  const days = await fetchScheduleRange("2026-07-25", "2026-07-26", {
    fetch: capturing,
    sleep: noSleep,
  });
  equal("one snapshot per date", days.length, 2);
  equal("the first date is correct", days[0].date, "2026-07-25");
  equal("the second date is correct", days[1].date, "2026-07-26");
  equal("games are normalised", days[0].games[0].gamePk, 776529);
  // A month of backfill is one request, not thirty.
  check("a range is a single request", capturedUrl.includes("startDate=2026-07-25"), capturedUrl);
  check("the end date is sent", capturedUrl.includes("endDate=2026-07-26"), capturedUrl);

  let threw = false;
  try {
    await fetchScheduleRange("2026-07-26", "2026-07-25", { fetch: capturing, sleep: noSleep });
  } catch {
    threw = true;
  }
  check("a reversed range is rejected", threw);
}

// ---------------------------------------------------------------------------
section("End to end");
// ---------------------------------------------------------------------------
{
  const live: typeof globalThis.fetch = async () => jsonResponse(fixtures.scheduleResponse);
  const result = await fetchSchedule("2026-07-25", { fetch: live, sleep: noSleep });

  equal("the full day round-trips", result.games.length, 6);
  check("a fetch timestamp is stamped on", result.fetchedAt.endsWith("Z"));

  // The handoff to the simulator: every predictable game must carry the seed
  // and identity the next stage needs.
  const predictable = result.games.filter((game) => game.isPredictable);
  equal("four games are worth predicting", predictable.length, 4);
  check(
    "every predictable game has a seed",
    predictable.every((game) => game.seed.startsWith("mlb:")),
  );
  check(
    "every predictable game identifies both teams",
    predictable.every((game) => game.home.id > 0 && game.away.id > 0),
  );
  check(
    "seeds are stable across fetches",
    seedForGame(776529) === result.games.find((g) => g.gamePk === 776529)?.seed,
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${"-".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log("All checks passed.");
