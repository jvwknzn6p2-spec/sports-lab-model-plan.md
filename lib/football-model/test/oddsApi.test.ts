/**
 * The Odds API のサンプル（probe/football・2026-09-03 取得）で、J1 と EPL の全チームが
 * football-data.co.uk の名前へ解決することと、市場確率の性質を固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFootballDataRaw } from "../src/footballDataRaw.ts";
import { parseOddsEvents, type OddsEvent } from "../src/oddsApi.ts";
import { buildTeamResolver } from "../src/teamAliases.ts";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(fx(name)) as OddsEvent[];

function namesOf(csv: string, divisions?: string[]): Set<string> {
  const r = parseFootballDataRaw(csv, divisions ? { divisions } : {});
  const s = new Set<string>();
  for (const m of r.matches) {
    s.add(m.home);
    s.add(m.away);
  }
  return s;
}

test("J1: Odds API の 20 チームが全て JPN.csv の名前へ解決する", () => {
  const resolve = buildTeamResolver(namesOf(fx("fd-JPN.csv"), ["JAP"]));
  const fixtures = parseOddsEvents(json("odds-soccer_japan_j_league.json"), resolve);
  assert.equal(fixtures.length, 10);
  const unresolved = fixtures.filter((f) => !f.resolved).map((f) => `${f.home} v ${f.away}`);
  assert.deepEqual(unresolved, []);
  const f = fixtures[0];
  assert.equal(f.kickoffAt, "2026-09-05T10:00:00Z");
  assert.deepEqual([f.home, f.away], ["Avispa Fukuoka", "Mito"]);
  assert.ok(f.bookmakers >= 10);
  assert.ok(f.market && Math.abs(f.market[0] + f.market[1] + f.market[2] - 1) < 1e-9);
  assert.ok(f.market![0] > f.market![2]); // 1.94 vs 3.7 → ホーム優位
});

test("EPL: Odds API の 20 チームが全て E0.csv の名前へ解決する", () => {
  const resolve = buildTeamResolver(namesOf(fx("fd-E0-2627.csv")));
  const fixtures = parseOddsEvents(json("odds-soccer_epl.json"), resolve);
  assert.equal(fixtures.length, 20);
  assert.deepEqual(fixtures.filter((f) => !f.resolved), []);
  const names = new Set(fixtures.flatMap((f) => [f.home, f.away]));
  for (const n of ["Man City", "Nott'm Forest", "Brighton", "Coventry"]) assert.ok(names.has(n), n);
});

test("解決できない名前は null（推測で埋めない）", () => {
  const resolve = buildTeamResolver(["Kashima Antlers"]);
  assert.equal(resolve("Kashima Antlers"), "Kashima Antlers");
  assert.equal(resolve("Unknown Club"), null);
  const [f] = parseOddsEvents([{ ...json("odds-soccer_japan_j_league.json")[0], home_team: "Unknown Club" }], resolve);
  assert.equal(f.resolved, false);
  assert.equal(f.home, "Unknown Club");
});

test("市場確率は各ブックの含意確率の中央値", () => {
  const ev: OddsEvent = {
    id: "x",
    sport_key: "soccer_epl",
    commence_time: "2026-09-05T14:00:00Z",
    home_team: "A",
    away_team: "B",
    bookmakers: [
      { key: "b1", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2 }, { name: "B", price: 4 }, { name: "Draw", price: 4 }] }] },
      { key: "b2", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 2 }, { name: "B", price: 4 }, { name: "Draw", price: 4 }] }] },
      { key: "b3", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 10 }, { name: "B", price: 1.2 }, { name: "Draw", price: 8 }] }] }, // 異常値
    ],
  };
  const [f] = parseOddsEvents([ev]);
  assert.equal(f.bookmakers, 3);
  assert.ok(Math.abs(f.market![0] - 0.5) < 1e-9); // 中央値は b1/b2 の 0.5
});

// 海外 8 リーグ（Founder 指示 2026-09-03・J1 より優先）。probe 2026-09-03 の実データで、
// Odds API に出た全チームが今季 CSV（2627）の名前へ解決することを固定する
const OVERSEAS: Array<[string, string]> = [
  ["I1", "soccer_italy_serie_a"],
  ["SP1", "soccer_spain_la_liga"],
  ["D1", "soccer_germany_bundesliga"],
  ["N1", "soccer_netherlands_eredivisie"],
  ["F1", "soccer_france_ligue_one"],
  ["P1", "soccer_portugal_primeira_liga"],
  ["B1", "soccer_belgium_first_div"],
  ["SC0", "soccer_spl"],
];
for (const [div, sport] of OVERSEAS) {
  test(`${div}: Odds API の全チームが ${div}-2627.csv の名前へ解決する`, () => {
    const resolve = buildTeamResolver(namesOf(fx(`fd-${div}-2627.csv`)));
    const fixtures = parseOddsEvents(json(`odds-${sport}.json`), resolve);
    assert.ok(fixtures.length > 0, "サンプルに試合が無い");
    const unresolved = fixtures.filter((f) => !f.resolved).map((f) => `${f.home} v ${f.away}`);
    assert.deepEqual(unresolved, []);
  });
}
