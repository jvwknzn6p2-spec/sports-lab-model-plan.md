/**
 * NPB availability and posted-order builders.
 *
 * These fill the bundle's league-agnostic `injuries` / `lineups` /
 * `lineupBatting` maps, so what they produce is consumed by exactly the
 * code that already serves MLB. The behaviour worth pinning is what happens
 * when npb.jp gives less than everything — which, before first pitch, is
 * the normal case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildNpbAvailability,
  buildNpbLineups,
  npbBatterId,
  parseGameSlugs,
  rosterWindow,
} from "../src/npb/roster";
import { NPB_TEAMS, teamByFullName } from "../src/npb/teams";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "probe", "npb");
const read = (name: string) => readFileSync(join(FX, name), "utf-8");

/** A fetch that serves canned bodies by URL substring; 404s anything else. */
function stubFetch(routes: Record<string, string>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(body, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

test("the roster window covers the full de-registration bar", () => {
  const w = rosterWindow("2026-08-23", 10);
  assert.equal(w.length, 10);
  assert.equal(w[0], "2026-08-14");
  assert.equal(w[9], "2026-08-23", "the window includes the slate date itself");
  // Month boundaries are real dates, not string arithmetic.
  assert.equal(rosterWindow("2026-03-02", 4)[0], "2026-02-27");
});

test("a de-registered player is unavailable; a later recall clears him", async () => {
  const sample = read("npb-roster-moves.html");
  const av = await buildNpbAvailability("2026-08-23", stubFetch({ roster_: sample }), 2);

  // Every day in the window serves the same 2026-08-23 page here, so the
  // 登録 list cancels the 抹消 list of the identical day: what survives is
  // exactly the players de-registered and not re-registered.
  const all = Object.values(av.unavailable).flat();
  assert.ok(all.length > 0, "the sample has de-registrations");
  assert.ok(
    all.every((p) => p.status.startsWith("登録抹消")),
    JSON.stringify(all.slice(0, 3)),
  );
  const registeredNames = ["則本", "平山"];
  for (const name of registeredNames) {
    assert.ok(
      !all.some((p) => p.name.includes(name)),
      `${name} was re-registered that day and must not read as unavailable`,
    );
  }
});

test("a missing 公示 warns and is skipped, never fatal", async () => {
  // The flag changes no number; losing a whole slate over one 404 page would
  // trade a real prediction for an informational one.
  const av = await buildNpbAvailability("2026-08-23", stubFetch({}), 3);
  assert.deepEqual(av.unavailable, {});
  assert.equal(av.warnings.length, 3, av.warnings.join(" | "));
  assert.ok(av.warnings[0]!.includes("unavailable"));
});

test("game slugs are discovered for the requested date only", () => {
  const index = read("npb-games-index.html");
  const on23 = parseGameSlugs(index, "2026-08-23");
  assert.ok(on23.length > 0, "the index carries 2026-08-23 games");
  assert.ok(on23.includes("h-b-17"), on23.join(", "));
  // A date the index does not carry yields nothing — not everything.
  assert.deepEqual(parseGameSlugs(index, "2026-01-01"), []);
  // Different dates give different cards.
  assert.notDeepEqual(parseGameSlugs(index, "2026-08-22"), on23);
});

test("batter ids are stable, club-scoped, and survive leading zeros", () => {
  const a = npbBatterId(901, "01705130");
  const b = npbBatterId(901, "1705130");
  assert.notEqual(a, b, "a leading zero is part of the id, not decoration");
  assert.equal(a, npbBatterId(901, "01705130"), "stable across calls");
  assert.notEqual(a, npbBatterId(902, "01705130"), "club-scoped");
  assert.ok(Number.isSafeInteger(a));

  // No collisions across every club for the ids in the committed samples.
  const ids = new Set<number>();
  const players = [...read("npb-game-1-index.html").matchAll(
    /\/bis\/players\/(\d+)\.html/g,
  )].map((m) => m[1]!);
  assert.ok(players.length >= 20, `only ${players.length} ids in the sample`);
  for (const team of NPB_TEAMS) {
    for (const p of players) ids.add(npbBatterId(team.teamId, p));
  }
  assert.equal(
    ids.size,
    NPB_TEAMS.length * new Set(players).size,
    "synthetic batter ids must not collide",
  );
});

test("a posted order becomes a lineup with each bat's season line", async () => {
  const away = teamByFullName("オリックス・バファローズ");
  const home = teamByFullName("福岡ソフトバンクホークス");
  const report = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [{ gamePk: 5001, home, away }],
    fetchImpl: stubFetch({
      "/games/2026/": read("npb-games-index.html"),
      "/scores/2026/0823/": read("npb-game-1-index.html"),
      // Both clubs are served the same batting page here; the point under
      // test is the wiring, and unmatched bats are expected to warn.
      "/stats/idb1_": read("npb-bis-idb1-giants.html"),
    }),
  });

  const lineup = report.lineups["5001"];
  assert.ok(lineup, Object.keys(report.lineups).join(", "));
  assert.equal(lineup.away.length, 9);
  assert.equal(lineup.home.length, 9);
  assert.equal(lineup.away[0]!.name, "宗", "leadoff, in order");
  assert.ok(lineup.away.every((s) => Number.isSafeInteger(s.playerId)));
  // Away and home ids must not overlap even if two clubs shared a name.
  const ids = new Set([...lineup.away, ...lineup.home].map((s) => s.playerId));
  assert.equal(ids.size, 18);
});

test("no games index means no lineups — and says so, rather than failing", async () => {
  const away = teamByFullName("オリックス・バファローズ");
  const home = teamByFullName("福岡ソフトバンクホークス");
  const report = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [{ gamePk: 5001, home, away }],
    fetchImpl: stubFetch({}),
  });
  assert.deepEqual(report.lineups, {});
  assert.deepEqual(report.lineupBatting, {});
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0]!.includes("games index"), report.warnings[0]);
});

test("an unposted order leaves the team-season offense standing", async () => {
  const away = teamByFullName("オリックス・バファローズ");
  const home = teamByFullName("福岡ソフトバンクホークス");
  const report = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [{ gamePk: 5001, home, away }],
    fetchImpl: stubFetch({
      "/games/2026/": read("npb-games-index.html"),
      // The game page exists but carries no order — the pre-game state.
      "/scores/2026/0823/": "<html><body>まもなく開始</body></html>",
    }),
  });
  assert.deepEqual(report.lineups, {}, "no lineup is recorded");
  assert.ok(
    report.warnings.some((w) => w.includes("no order posted")),
    report.warnings.join(" | "),
  );
});

test("an empty slate does no fetching at all", async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const report = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [],
    fetchImpl: counting,
  });
  assert.equal(calls, 0);
  assert.deepEqual(report.lineups, {});
});

test("far from first pitch, no order fetch is made at all", async () => {
  // The slate is rebuilt SEVEN times a day. A morning rebuild cannot find a
  // lineup that clubs post hours later, so spending ~19 npb.jp requests on
  // it is pure cost at a small site with no API — and being blocked would
  // cost the whole NPB pipeline, not just this feature.
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const report = await buildNpbLineups({
    date: "2026-08-25",
    year: 2026,
    games: [
      {
        gamePk: 5001,
        home: teamByFullName("福岡ソフトバンクホークス"),
        away: teamByFullName("オリックス・バファローズ"),
        gameDate: "2026-08-25T09:00:00.000Z", // 18:00 JST
      },
    ],
    fetchImpl: counting,
    now: new Date("2026-08-25T00:07:00.000Z"), // 09:07 JST — the slate cron
  });

  assert.equal(calls, 0, "not one request before the window");
  assert.deepEqual(report.lineups, {});
  assert.ok(
    report.warnings.some((w) => w.includes("within")),
    report.warnings.join(" | "),
  );
});

test("inside the window the fetch happens; an unknown start time never skips", async () => {
  const routes = {
    "/games/2026/": read("npb-games-index.html"),
    "/scores/2026/0823/": read("npb-game-1-index.html"),
    "/stats/idb1_": read("npb-bis-idb1-giants.html"),
  };
  const home = teamByFullName("福岡ソフトバンクホークス");
  const away = teamByFullName("オリックス・バファローズ");

  // 90 minutes out — inside ORDER_FETCH_WINDOW_HOURS.
  const close = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [
      { gamePk: 5001, home, away, gameDate: "2026-08-23T09:00:00.000Z" },
    ],
    fetchImpl: stubFetch(routes),
    now: new Date("2026-08-23T07:30:00.000Z"),
  });
  assert.ok(close.lineups["5001"], close.warnings.join(" | "));

  // No posted start time: absent evidence the game is far off, look anyway.
  const unknown = await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [{ gamePk: 5001, home, away, gameDate: null }],
    fetchImpl: stubFetch(routes),
    now: new Date("2026-08-23T00:07:00.000Z"),
  });
  assert.ok(unknown.lineups["5001"], unknown.warnings.join(" | "));
});

test("club batting pages are read only for clubs that actually posted", async () => {
  // Before the orders land this must be ZERO pages, not twelve.
  const requested: string[] = [];
  const tracking = (async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/games/2026/")) {
      return new Response(read("npb-games-index.html"), { status: 200 });
    }
    // Every game page exists but carries no order — the pre-game state.
    return new Response("<html>まもなく開始</html>", { status: 200 });
  }) as unknown as typeof fetch;

  await buildNpbLineups({
    date: "2026-08-23",
    year: 2026,
    games: [
      {
        gamePk: 5001,
        home: teamByFullName("福岡ソフトバンクホークス"),
        away: teamByFullName("オリックス・バファローズ"),
        gameDate: null,
      },
    ],
    fetchImpl: tracking,
  });

  assert.equal(
    requested.filter((u) => u.includes("idb1_")).length,
    0,
    "no order posted → no club batting pages",
  );
});
