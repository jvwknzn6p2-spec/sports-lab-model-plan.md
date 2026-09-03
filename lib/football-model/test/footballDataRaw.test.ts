import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFootballDataRaw, parseUkDate } from "../src/footballDataRaw.ts";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

test("parseUkDate", () => {
  assert.equal(parseUkDate("21/08/2026"), "2026-08-21");
  assert.equal(parseUkDate("5/3/26"), "2026-03-05");
  assert.equal(parseUkDate("2026-08-21"), null);
});

test("主要リーグ（E0 2026/27・BOM 付き）: 得点・時刻・B365 オッズ", () => {
  const r = parseFootballDataRaw(fx("fd-E0-2627.csv"));
  assert.equal(r.dropped, 0);
  assert.ok(r.matches.length >= 20);
  const m = r.matches[0];
  assert.equal(m.division, "E0");
  assert.equal(m.date, "2026-08-21T20:00:00Z");
  assert.deepEqual([m.home, m.away, m.homeGoals, m.awayGoals], ["Arsenal", "Coventry", 3, 0]);
  assert.deepEqual(m.odds, { home: 1.2, draw: 7, away: 13 });
  assert.equal(r.fixtures.length, 0);
});

test("追加リーグ（JPN.csv）: Division は JAP、クロージング平均へフォールバック、2026/2027 季まで", () => {
  const r = parseFootballDataRaw(fx("fd-JPN.csv"), { divisions: ["JAP"] });
  assert.ok(r.matches.length > 4500, String(r.matches.length));
  const first = r.matches[0];
  assert.equal(first.division, "JAP");
  assert.equal(first.date, "2012-03-10T05:00:00Z");
  assert.deepEqual([first.home, first.away, first.homeGoals, first.awayGoals], ["Gamba Osaka", "Vissel Kobe", 2, 3]);
  assert.deepEqual(first.odds, { home: 1.94, draw: 3.56, away: 4.34 }); // B365C 無し → Pinnacle クロージング
  const last = r.matches[r.matches.length - 1];
  assert.ok(last.date >= "2026-08-29", last.date);
  assert.ok(last.odds !== null);
});

test("fixtures.csv: 未消化の試合は fixtures に入り、得点が無い", () => {
  const r = parseFootballDataRaw(fx("fd-fixtures.csv"));
  assert.equal(r.matches.length, 0);
  assert.ok(r.fixtures.length >= 40);
  const f = r.fixtures[0];
  assert.equal(f.division, "B1");
  assert.equal(f.dateLocal, "2026-09-02");
  assert.equal(f.timeLocal, "19:30");
  assert.ok(f.odds && f.odds.home > 1);
});
