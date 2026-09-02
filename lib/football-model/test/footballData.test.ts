import { test } from "node:test";
import assert from "node:assert/strict";
import { impliedProbabilities, loadMatches, parseCsv } from "../src/footballData.ts";

const CSV = [
  "Division,MatchDate,MatchTime,HomeTeam,AwayTeam,FTHome,FTAway,FTResult,OddHome,OddDraw,OddAway",
  "JAP,2024-12-08,11:00:00,Albirex Niigata,Kyoto,2.0,0.0,H,2.03,3.46,3.58",
  "JAP,2024-12-08,11:00:00,Kashima Antlers,Urawa Reds,,,,1.9,3.4,4.0", // 得点なし → 捨てる
  "E0,2025-05-25,16:00:00,Wolves,Brentford,1.0,1.0,D,2.71,3.76,2.43",
  'E0,2025-05-25,,"Man United",Aston Villa,0.0,2.0,A,,,', // 時刻なし・オッズなし
].join("\n");

test("parseCsv / loadMatches: 得点の無い行は捨て、時刻とオッズの欠損を扱う", () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 4);
  const all = loadMatches(rows);
  assert.equal(all.length, 3);
  assert.deepEqual(
    all[0],
    {
      division: "JAP",
      date: "2024-12-08T11:00:00Z",
      home: "Albirex Niigata",
      away: "Kyoto",
      homeGoals: 2,
      awayGoals: 0,
      odds: { home: 2.03, draw: 3.46, away: 3.58 },
    },
  );
  const mu = all[2];
  assert.equal(mu.home, "Man United");
  assert.equal(mu.date, "2025-05-25T00:00:00Z");
  assert.equal(mu.odds, null);
});

test("loadMatches: Division で絞れる", () => {
  const jap = loadMatches(parseCsv(CSV), { divisions: ["JAP"] });
  assert.equal(jap.length, 1);
  assert.equal(jap[0].division, "JAP");
});

test("impliedProbabilities: 合計 1・オッズの逆順", () => {
  const p = impliedProbabilities({ home: 2.0, draw: 3.5, away: 4.0 });
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-12);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
  // 控除 7% 相当を按分で除く: 1/2 / (1/2 + 1/3.5 + 1/4)
  assert.ok(Math.abs(p[0] - 0.5 / (0.5 + 1 / 3.5 + 0.25)) < 1e-12);
});
