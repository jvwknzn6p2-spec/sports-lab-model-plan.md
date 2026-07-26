import { test } from "node:test";
import assert from "node:assert/strict";
import { MlbClient, MlbApiError, type FetchLike } from "./client";
import {
  fetchBullpen,
  fetchCoreGames,
  fetchRecentForm,
  fetchStartingPitcher,
  fetchTeamBatting,
  seasonForDate,
  shiftDate,
} from "./fetch";
import {
  firstSplitStat,
  parseInningsPitched,
  parseStatNumber,
  statsResponseSchema,
  teamsResponseSchema,
} from "./responses";
import { coreGameSchema } from "../../schemas";

const NOW = "2024-07-25T12:00:00Z";

/* -------------------------------------------------------------------------- */
/* Recorded fixtures — shapes as the MLB Stats API returns them.              */
/* -------------------------------------------------------------------------- */

const SCHEDULE = {
  dates: [
    {
      date: "2024-07-25",
      games: [
        {
          gamePk: 745444,
          gameDate: "2024-07-25T23:10:00Z",
          gameType: "R",
          status: { abstractGameState: "Preview", detailedState: "Scheduled" },
          venue: { id: 2392, name: "Daikin Park" },
          teams: {
            away: {
              team: { id: 108, name: "Los Angeles Angels" },
              probablePitcher: { id: 656302, fullName: "Reid Detmers" },
            },
            home: {
              team: { id: 117, name: "Houston Astros" },
              probablePitcher: { id: 664285, fullName: "Framber Valdez" },
            },
          },
        },
      ],
    },
  ],
};

const TEAMS = {
  teams: [
    { id: 108, name: "Los Angeles Angels", abbreviation: "LAA" },
    { id: 117, name: "Houston Astros", abbreviation: "HOU" },
  ],
};

/** Season pitching line. Note every rate stat arrives as a string. */
const PITCHING = {
  stats: [
    {
      type: { displayName: "season" },
      group: { displayName: "pitching" },
      splits: [
        {
          season: "2024",
          // "120.1" is 120 and ONE THIRD innings, not 120.1.
          stat: { era: "2.90", whip: "1.08", inningsPitched: "120.1", strikeOuts: 130 },
        },
      ],
    },
  ],
};

const HITTING = {
  stats: [
    {
      type: { displayName: "season" },
      group: { displayName: "hitting" },
      splits: [{ season: "2024", stat: { runs: 490, gamesPlayed: 101, obp: ".318", slg: ".408" } }],
    },
  ],
};

const BULLPEN_SPLIT = {
  stats: [
    {
      type: { displayName: "statSplits" },
      group: { displayName: "pitching" },
      splits: [{ season: "2024", stat: { era: "3.75", inningsPitched: "310.2" } }],
    },
  ],
};

/** Two completed games for recent-form derivation. */
const TEAM_SCHEDULE = {
  dates: [
    {
      date: "2024-07-23",
      games: [
        {
          gamePk: 1,
          gameDate: "2024-07-23T23:10:00Z",
          status: { abstractGameState: "Final" },
          teams: {
            home: { team: { id: 117, name: "Houston Astros" }, score: 7 },
            away: { team: { id: 108, name: "Los Angeles Angels" }, score: 3 },
          },
        },
      ],
    },
    {
      date: "2024-07-24",
      games: [
        {
          gamePk: 2,
          gameDate: "2024-07-24T23:10:00Z",
          status: { abstractGameState: "Final" },
          teams: {
            home: { team: { id: 108, name: "Los Angeles Angels" }, score: 2 },
            away: { team: { id: 117, name: "Houston Astros" }, score: 1 },
          },
        },
        {
          // In progress — must not count toward form.
          gamePk: 3,
          gameDate: "2024-07-24T23:10:00Z",
          status: { abstractGameState: "Live" },
          teams: {
            home: { team: { id: 117, name: "Houston Astros" }, score: 1 },
            away: { team: { id: 133, name: "Oakland Athletics" }, score: 0 },
          },
        },
      ],
    },
  ],
};

/** A fetch stub that routes on path, and records every URL requested. */
function stubFetch(routes: Array<[RegExp, unknown]>, urls: string[] = []): FetchLike {
  return async (url) => {
    urls.push(url);
    for (const [pattern, body] of routes) {
      if (pattern.test(url)) {
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, text: async () => "not found" };
  };
}

const ALL_ROUTES: Array<[RegExp, unknown]> = [
  [/\/teams\?/, TEAMS],
  [/\/schedule\?.*teamId=/, TEAM_SCHEDULE],
  [/\/schedule\?/, SCHEDULE],
  [/\/people\/\d+\/stats/, PITCHING],
  [/\/teams\/\d+\/stats\?.*group=hitting/, HITTING],
  [/\/teams\/\d+\/stats\?.*sitCodes=rp/, BULLPEN_SPLIT],
];

function client(routes = ALL_ROUTES, urls: string[] = []): MlbClient {
  return new MlbClient({
    fetch: stubFetch(routes, urls),
    minIntervalMs: 0,
    sleep: async () => {},
  });
}

/* -------------------------------------------------------------------------- */
/* Value parsing — the two real traps                                         */
/* -------------------------------------------------------------------------- */

test("innings pitched decodes baseball notation, not decimals", () => {
  assert.equal(parseInningsPitched("120.0"), 120);
  // .1 is ONE OUT = one third of an inning.
  assert.ok(Math.abs(parseInningsPitched("120.1")! - (120 + 1 / 3)) < 1e-9);
  assert.ok(Math.abs(parseInningsPitched("120.2")! - (120 + 2 / 3)) < 1e-9);
  assert.equal(parseInningsPitched("7"), 7);
});

test("reading innings pitched as a plain float would be wrong", () => {
  // Guards the trap directly: the naive reading differs from the correct one.
  assert.notEqual(parseInningsPitched("120.2"), Number("120.2"));
});

test("invalid outs notation is rejected rather than guessed", () => {
  assert.equal(parseInningsPitched("120.5"), null);
  assert.equal(parseInningsPitched("abc"), null);
  assert.equal(parseInningsPitched("-.--"), null);
  assert.equal(parseInningsPitched(null), null);
});

test("stat strings parse, and placeholders become null", () => {
  assert.equal(parseStatNumber("2.90"), 2.9);
  assert.equal(parseStatNumber(".318"), 0.318);
  assert.equal(parseStatNumber(4), 4);
  for (const placeholder of ["-.--", "-", ".---", "", "   "]) {
    assert.equal(parseStatNumber(placeholder), null, `"${placeholder}" should be null`);
  }
});

test("firstSplitStat picks the requested group and reports absence as null", () => {
  const parsed = statsResponseSchema.parse(PITCHING);
  assert.equal(firstSplitStat(parsed, "pitching")?.era, "2.90");
  assert.equal(firstSplitStat(parsed, "hitting"), null);
});

/* -------------------------------------------------------------------------- */
/* Client behaviour                                                            */
/* -------------------------------------------------------------------------- */

test("a 5xx is retried and can succeed", async () => {
  let calls = 0;
  const c = new MlbClient({
    minIntervalMs: 0,
    sleep: async () => {},
    fetch: async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 503, text: async () => "" };
      return { ok: true, status: 200, text: async () => JSON.stringify(TEAMS) };
    },
  });
  const result = await c.get("/teams", {}, teamsResponseSchema);
  assert.equal(result.teams.length, 2);
  assert.equal(calls, 3);
});

test("a 4xx is not retried — we asked wrongly", async () => {
  let calls = 0;
  const c = new MlbClient({
    minIntervalMs: 0,
    sleep: async () => {},
    fetch: async () => {
      calls++;
      return { ok: false, status: 404, text: async () => "" };
    },
  });
  await assert.rejects(
    () => c.get("/teams", {}, teamsResponseSchema),
    (e: unknown) => e instanceof MlbApiError && e.status === 404,
  );
  assert.equal(calls, 1);
});

test("a changed response shape fails loudly instead of yielding nulls", async () => {
  const c = new MlbClient({
    minIntervalMs: 0,
    sleep: async () => {},
    // `teams` renamed upstream — every downstream number would be suspect.
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ clubs: [] }) }),
  });
  await assert.rejects(
    () => c.get("/teams", {}, teamsResponseSchema),
    /unexpected response shape/,
  );
});

test("a non-JSON body is an error, not a crash", async () => {
  const c = new MlbClient({
    minIntervalMs: 0,
    sleep: async () => {},
    fetch: async () => ({ ok: true, status: 200, text: async () => "<html>maintenance</html>" }),
  });
  await assert.rejects(
    () => c.get("/teams", {}, teamsResponseSchema),
    /not valid JSON/,
  );
});

test("unset query params are omitted from the URL", async () => {
  const urls: string[] = [];
  await fetchRecentForm(client(ALL_ROUTES, urls), 117, "2024-07-25", NOW);
  const scheduleUrl = urls.find((u) => u.includes("teamId=117"))!;
  assert.ok(!scheduleUrl.includes("undefined"), scheduleUrl);
});

/* -------------------------------------------------------------------------- */
/* Entity mapping                                                              */
/* -------------------------------------------------------------------------- */

test("a starting pitcher maps with innings decoded correctly", async () => {
  const p = await fetchStartingPitcher(client(), 664285, "Framber Valdez", 2024, false);
  assert.equal(p.playerId, "664285");
  assert.equal(p.name, "Framber Valdez");
  assert.equal(p.seasonEra, 2.9);
  assert.equal(p.seasonWhip, 1.08);
  assert.ok(Math.abs(p.inningsPitched! - (120 + 1 / 3)) < 1e-9);
  assert.equal(p.confirmed, false);
});

test("team batting derives runs per game from totals", async () => {
  const b = await fetchTeamBatting(client(), 117, 2024, NOW);
  assert.ok(Math.abs(b.runsPerGame! - 490 / 101) < 1e-9);
  assert.equal(b.onBasePct, 0.318);
  assert.equal(b.sluggingPct, 0.408);
  assert.equal(b.wOBA, null, "the API does not publish wOBA; it must not be approximated");
  assert.equal(b.fetchedAt, NOW);
});

test("zero games played yields null rather than a divide-by-zero", async () => {
  const openingDay = {
    stats: [
      {
        group: { displayName: "hitting" },
        splits: [{ stat: { runs: 0, gamesPlayed: 0 } }],
      },
    ],
  };
  const b = await fetchTeamBatting(
    client([[/group=hitting/, openingDay]]),
    117,
    2024,
    NOW,
  );
  assert.equal(b.runsPerGame, null);
});

test("bullpen ERA comes from the relief split", async () => {
  const b = await fetchBullpen(client(), 117, 2024, NOW);
  assert.equal(b.era, 3.75);
  assert.equal(b.inningsPitchedLast3Days, null, "recent workload is a separate ingest");
});

test("an unavailable relief split leaves ERA null, never the team's overall ERA", async () => {
  // Folding the rotation into the bullpen number would flatter or damage every
  // late-innings estimate, so absence must stay absence.
  const b = await fetchBullpen(client([[/nothing/, {}]]), 117, 2024, NOW);
  assert.equal(b.era, null);
  assert.equal(b.teamId, "117");
});

/* -------------------------------------------------------------------------- */
/* Recent form                                                                 */
/* -------------------------------------------------------------------------- */

test("recent form counts only completed games, from the team's perspective", async () => {
  const form = await fetchRecentForm(client(), 117, "2024-07-25", NOW);
  assert.equal(form.sampleSize, 2, "the in-progress game must not count");
  assert.equal(form.wins, 1);
  assert.equal(form.losses, 1);
  // Won 7-3 at home, lost 1-2 away.
  assert.equal(form.runsScoredPerGame, (7 + 1) / 2);
  assert.equal(form.runsAllowedPerGame, (3 + 2) / 2);
});

test("recent form reads the away side correctly for the away team", async () => {
  const form = await fetchRecentForm(client(), 108, "2024-07-25", NOW);
  assert.equal(form.sampleSize, 2);
  // Angels lost 3-7, then won 2-1.
  assert.equal(form.wins, 1);
  assert.equal(form.runsScoredPerGame, (3 + 2) / 2);
});

test("the form window ends the day before the slate", async () => {
  const urls: string[] = [];
  await fetchRecentForm(client(ALL_ROUTES, urls), 117, "2024-07-25", NOW, { window: 10 });
  const url = urls.find((u) => u.includes("teamId=117"))!;
  assert.ok(url.includes("endDate=2024-07-24"), url);
  assert.ok(url.includes("startDate=2024-06-25"), url);
});

/* -------------------------------------------------------------------------- */
/* Slate assembly                                                              */
/* -------------------------------------------------------------------------- */

test("a slate assembles into schema-valid CoreGame records", async () => {
  const result = await fetchCoreGames(client(), "2024-07-25", { fetchedAt: NOW });

  assert.equal(result.failures.length, 0);
  assert.equal(result.games.length, 1);

  const game = result.games[0];
  // The whole point of Steps 1-2: the contract the library was built against.
  assert.equal(coreGameSchema.safeParse(game).success, true);

  assert.equal(game.gameId, "745444");
  assert.equal(game.startTime, "2024-07-25T23:10:00.000Z");
  assert.equal(game.venueId, "2392");
  assert.equal(game.venueName, "Daikin Park");
  assert.equal(game.home.abbreviation, "HOU", "abbreviation must resolve for the park lookup");
  assert.equal(game.away.abbreviation, "LAA");
  assert.equal(game.homeStarter?.name, "Framber Valdez");
  assert.equal(game.awayStarter?.name, "Reid Detmers");
  assert.ok(game.homeBatting?.runsPerGame !== null);
  assert.equal(game.homeBullpen?.era, 3.75);
});

test("a probable pitcher is not treated as confirmed by default", async () => {
  const result = await fetchCoreGames(client(), "2024-07-25", { fetchedAt: NOW });
  assert.equal(result.games[0].homeStarter?.confirmed, false);

  const opted = await fetchCoreGames(client(), "2024-07-25", {
    fetchedAt: NOW,
    treatProbableAsConfirmed: true,
  });
  assert.equal(opted.games[0].homeStarter?.confirmed, true);
});

test("a game with no named starter yields null, not a fabricated one", async () => {
  const noStarter = structuredClone(SCHEDULE);
  delete (noStarter.dates[0].games[0].teams.home as { probablePitcher?: unknown }).probablePitcher;

  const routes: Array<[RegExp, unknown]> = [
    [/\/teams\?/, TEAMS],
    [/\/schedule\?/, noStarter],
    [/\/people\/\d+\/stats/, PITCHING],
    [/group=hitting/, HITTING],
    [/sitCodes=rp/, BULLPEN_SPLIT],
  ];
  const result = await fetchCoreGames(client(routes), "2024-07-25", { fetchedAt: NOW });
  assert.equal(result.games[0].homeStarter, null);
  assert.notEqual(result.games[0].awayStarter, null);
});

test("one malformed game is reported without costing the rest of the slate", async () => {
  const mixed = structuredClone(SCHEDULE);
  const broken = structuredClone(mixed.dates[0].games[0]);
  broken.gamePk = 999;
  delete (broken as { venue?: unknown }).venue;
  mixed.dates[0].games.push(broken);

  const routes: Array<[RegExp, unknown]> = [
    [/\/teams\?/, TEAMS],
    [/\/schedule\?/, mixed],
    [/\/people\/\d+\/stats/, PITCHING],
    [/group=hitting/, HITTING],
    [/sitCodes=rp/, BULLPEN_SPLIT],
  ];
  const result = await fetchCoreGames(client(routes), "2024-07-25", { fetchedAt: NOW });

  assert.equal(result.games.length, 1, "the healthy game still ships");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].gamePk, 999);
  assert.match(result.failures[0].message, /venue/);
});

test("a failed team lookup degrades to a derived abbreviation rather than throwing", async () => {
  const routes: Array<[RegExp, unknown]> = [
    [/\/schedule\?/, SCHEDULE],
    [/\/people\/\d+\/stats/, PITCHING],
    [/group=hitting/, HITTING],
    [/sitCodes=rp/, BULLPEN_SPLIT],
    // no /teams route → 404
  ];
  const result = await fetchCoreGames(client(routes), "2024-07-25", { fetchedAt: NOW });
  assert.equal(result.games.length, 1);
  // Falls back to a name-derived stub, which misses the park table and is
  // therefore flagged as a neutral fallback rather than matching a wrong park.
  assert.equal(result.games[0].home.abbreviation, "HOU".slice(0, 3));
});

test("only regular-season games are requested", async () => {
  const urls: string[] = [];
  await fetchCoreGames(client(ALL_ROUTES, urls), "2024-07-25", { fetchedAt: NOW });
  assert.ok(urls.some((u) => u.includes("/schedule") && u.includes("gameType=R")));
});

/* -------------------------------------------------------------------------- */
/* Date helpers                                                                */
/* -------------------------------------------------------------------------- */

test("shiftDate crosses month and year boundaries in UTC", () => {
  assert.equal(shiftDate("2024-07-25", -1), "2024-07-24");
  assert.equal(shiftDate("2024-08-01", -1), "2024-07-31");
  assert.equal(shiftDate("2024-01-01", -1), "2023-12-31");
  assert.equal(shiftDate("2024-02-28", 1), "2024-02-29", "2024 is a leap year");
});

test("seasonForDate reads the year", () => {
  assert.equal(seasonForDate("2024-07-25"), 2024);
  assert.throws(() => seasonForDate("nope"), RangeError);
});
