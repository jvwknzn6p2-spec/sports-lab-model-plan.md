/**
 * The last two NPB data gaps, parsed from the bytes npb.jp actually serves.
 *
 * Both parsers run against live samples committed 2026-08-24 under
 * probe/npb/ — the same fixtures-first discipline the rest of the NPB
 * support was built with. The samples came from a probe that first had to
 * establish where these pages even live: /scores/ is a JS redirect,
 * /scores/<year>/<MMDD>/ 404s, /announcement/ is a meta refresh carrying no
 * dated links, and /announcement/<year>/pitcher.html does not exist. What
 * the games index really links is what these tests read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchBatter,
  NpbParseError,
  parseNpbClubBatting,
  parseNpbGameOrder,
  parseNpbRosterMoves,
  type NpbBatterRow,
} from "../src/npb/parse";
import type { RawBattingLine } from "../src/sabermetrics";
import { npbUrls } from "../src/npb/slate";

const FX = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "probe", "npb");
const read = (name: string) => readFileSync(join(FX, name), "utf-8");

/** A zero line — these fixtures test NAME matching, not the numbers. */
const EMPTY_LINE: RawBattingLine = {
  plateAppearances: 0, atBats: 0, hits: 0, doubles: 0, triples: 0,
  homeRuns: 0, stolenBases: 0, caughtStealing: 0, sacFlies: 0,
  baseOnBalls: 0, intentionalWalks: 0, hitByPitch: 0, strikeOuts: 0,
};

test("a posted order parses to nine batters a side, with npb.jp player ids", () => {
  const order = parseNpbGameOrder(read("npb-game-1-index.html"));
  assert.ok(order, "the sample game has a posted order");

  // 2026-08-23 at ソフトバンク: オリックス bat first (先攻), the host second.
  assert.equal(order.away.team.fullName, "オリックス・バファローズ");
  assert.equal(order.home.team.fullName, "福岡ソフトバンクホークス");

  for (const side of [order.away, order.home]) {
    const batters = side.slots.filter((s) => s.slot !== null);
    assert.equal(batters.length, 9, side.team.fullName);
    assert.deepEqual(
      batters.map((s) => s.slot),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      `${side.team.fullName}: slots must be 1–9 in order`,
    );
    // The id is the stable key — the order block writes abbreviated names
    // (宗, 牧原大), which are not unique across the league.
    for (const s of batters) {
      assert.match(s.playerId, /^\d+$/, JSON.stringify(s));
      assert.ok(s.name.length > 0, JSON.stringify(s));
      assert.ok(s.position.length > 0, JSON.stringify(s));
    }
    // The starting pitcher rides along on a slot-less row.
    const pitcher = side.slots.find((s) => s.slot === null);
    assert.ok(pitcher, `${side.team.fullName}: pitcher row`);
    assert.equal(pitcher.position, "投");
  }

  // Spot-check the actual leadoff hitters against the committed bytes.
  assert.equal(order.away.slots[0]!.name, "宗");
  assert.equal(order.home.slots[0]!.name, "牧原大");
});

test("both committed game samples parse — one game is not a layout", () => {
  // A single sample can pass by luck. The second game is an independent
  // card (different clubs, different park) through the same parser.
  const order = parseNpbGameOrder(read("npb-game-2-index.html"));
  assert.ok(order);
  assert.notEqual(order.away.team.teamId, order.home.team.teamId);
  for (const side of [order.away, order.home]) {
    assert.equal(side.slots.filter((s) => s.slot !== null).length, 9);
  }
});

test("no order block means NOT POSTED — null, never a throw, never a guess", () => {
  // The pre-game state. A club posts its lineup a few hours before first
  // pitch, so the morning slate fetch routinely meets a page without one;
  // that must leave the team-season baseline standing, not fail the slate.
  assert.equal(parseNpbGameOrder("<html><body>no order here</body></html>"), null);
  assert.equal(
    parseNpbGameOrder('<div id="player-order"><h4>最新のオーダー</h4></div></div>'),
    null,
  );
});

test("a short order FAILS rather than re-basing offense on eight players", () => {
  const html = read("npb-game-1-index.html");
  // Drop the away side's leadoff row: eight bats where nine are required.
  // Matched within ONE <tr> — the live bytes are indented across several
  // lines, and a pattern allowed to cross </tr> would swallow every row
  // before this one and destroy the block instead of shortening the order.
  const broken = html.replace(
    /<tr>(?:(?!<\/tr>)[\s\S])*11815130(?:(?!<\/tr>)[\s\S])*<\/tr>/,
    "",
  );
  assert.notEqual(broken, html, "the fixture edit must actually apply");
  assert.throws(() => parseNpbGameOrder(broken), NpbParseError);
});

test("roster moves parse into registrations and de-registrations", () => {
  const moves = parseNpbRosterMoves(read("npb-roster-moves.html"));
  assert.equal(moves.date, "2026-08-23");
  assert.ok(moves.registered.length > 0);
  assert.ok(moves.deregistered.length > 0);

  for (const m of [...moves.registered, ...moves.deregistered]) {
    assert.match(m.playerId, /^\d+$/, JSON.stringify(m));
    assert.ok(m.team.teamId >= 901 && m.team.teamId <= 912, JSON.stringify(m));
    assert.ok(m.name.length > 0, JSON.stringify(m));
  }

  // 登録抹消 CONTAINS 登録 as a substring — the section split must not file
  // de-registrations as activations. These two are in the committed bytes.
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);
  assert.ok(
    names(moves.registered).some((n) => n.includes("則本")),
    names(moves.registered).join(", "),
  );
  assert.ok(
    names(moves.deregistered).some((n) => n.includes("坂本")),
    names(moves.deregistered).join(", "),
  );
  // …and no player may appear on both lists on the same day.
  const both = names(moves.registered).filter((n) =>
    names(moves.deregistered).includes(n),
  );
  assert.deepEqual(both, []);
});

test("a page without the dated heading fails loud", () => {
  assert.throws(
    () => parseNpbRosterMoves("<html><h4>お知らせ</h4></html>"),
    NpbParseError,
  );
});

test("the discovered URLs are the ones the live pages actually link", () => {
  // Pinned against probe/npb/manifest.txt, where each of these returned 200.
  assert.equal(
    npbUrls.gameOrder(2026, "0823", "h-b-17"),
    "https://npb.jp/scores/2026/0823/h-b-17/",
  );
  assert.equal(
    npbUrls.rosterMoves("0823"),
    "https://npb.jp/announcement/roster/roster_0823.html",
  );
  assert.equal(
    npbUrls.clubBatting(2026, "g"),
    "https://npb.jp/bis/2026/stats/idb1_g.html",
  );
});

test("a club batting page yields every batter, markers stripped", () => {
  const batters = parseNpbClubBatting(read("npb-bis-idb1-giants.html"));
  assert.ok(batters.length > 20, `only ${batters.length} batters`);
  // npb.jp marks qualifying rows with a leading "*"; the name must not keep it.
  assert.ok(batters.every((b) => !/^[*+＊＋]/.test(b.name)), "markers stripped");
  assert.ok(batters.every((b) => !/[\s　]/.test(b.compactName)));
  const izumiguchi = batters.find((b) => b.compactName.startsWith("泉口"));
  assert.ok(izumiguchi, "泉口 is in the committed sample");
  assert.ok(izumiguchi.line.atBats > 300, JSON.stringify(izumiguchi.line));
});

test("abbreviated order names resolve the way npb.jp abbreviates them", () => {
  const batters = parseNpbClubBatting(read("npb-bis-idb1-giants.html"));
  // The site shortens a posted order to the least form unique WITHIN the
  // club, so the abbreviation is a prefix of the full compacted name.
  const full = batters.find((b) => b.compactName.startsWith("泉口"))!;
  assert.equal(matchBatter("泉口", batters)?.compactName, full.compactName);
  assert.equal(matchBatter(full.compactName, batters)?.compactName, full.compactName);

  // Ambiguity is refused, never guessed — the same rule matchStarter follows.
  const twoYamamotos: NpbBatterRow[] = [
    { name: "山本 祐大", compactName: "山本祐大", line: full.line },
    { name: "山本 泰寛", compactName: "山本泰寛", line: full.line },
  ];
  assert.equal(matchBatter("山本", twoYamamotos), null, "ambiguous → null");
  assert.equal(matchBatter("山本祐", twoYamamotos)?.compactName, "山本祐大");
  assert.equal(matchBatter("該当なし", batters), null);
  assert.equal(matchBatter("", batters), null);
});

test("an exact name wins over a longer teammate that it prefixes", () => {
  // 松本 and 松本剛 can coexist: an exact hit must not be called ambiguous
  // just because another name starts with the same characters.
  const roster: NpbBatterRow[] = [
    { name: "松本", compactName: "松本", line: EMPTY_LINE },
    { name: "松本 剛", compactName: "松本剛", line: EMPTY_LINE },
  ];
  assert.equal(matchBatter("松本", roster)?.compactName, "松本");
  assert.equal(matchBatter("松本剛", roster)?.compactName, "松本剛");
});
