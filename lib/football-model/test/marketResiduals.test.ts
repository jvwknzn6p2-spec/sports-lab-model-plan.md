/**
 * 市場基盤の土台（A）。リークが無いこと・補正が恒等から始まること・CSV の読み取りを固定する。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryRow } from "../src/history.ts";
import { adjust, bestPriceBets, buildObservations, devig, fitGamma, parsePriceCsv } from "../src/marketResiduals.ts";

const row = (date: string, home: string, away: string, hg: number, ag: number, sot?: [number, number]): HistoryRow => ({
  division: "E0", date, time: null, home, away, homeGoals: hg, awayGoals: ag,
  odds: { home: 2.0, draw: 3.4, away: 3.8 }, ...(sot ? { sot: { home: sot[0], away: sot[1] } } : {}),
  source: "test", observedAt: date,
});

test("devig: 控除を除いた確率は和が 1 で、オッズの逆数に比例する", () => {
  const p = devig({ home: 2.0, draw: 3.4, away: 3.8 });
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-12);
  assert.ok(Math.abs(p[0] / p[2] - 3.8 / 2.0) < 1e-12);
});

test("adjust: γ=1・b=0 なら市場そのまま／γ>1 で本命が強まる", () => {
  const m: [number, number, number] = [0.7, 0.18, 0.12];
  const same = adjust(m, 0, { gamma: 1, b: 0 });
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(same[i]! - m[i]!) < 1e-12);
  const sharp = adjust(m, 0, { gamma: 1.11, b: 0 });
  assert.ok(sharp[0] > m[0] && sharp[2] < m[2]);
  // 特徴量はホームに +b·x、アウェイに −b·x
  const tilted = adjust([0.4, 0.3, 0.3], 1, { gamma: 1, b: 0.1 });
  assert.ok(tilted[0] > 0.4 && tilted[2] < 0.3);
});

test("buildObservations: 特徴量はその日より前の試合だけから作る（リークしない）", () => {
  const rows = [
    row("2026-01-01", "A", "B", 1, 0, [2, 5]),
    row("2026-01-08", "B", "A", 0, 0, [3, 3]),
    row("2026-01-15", "A", "B", 3, 0, [4, 1]),
    row("2026-01-22", "B", "A", 2, 2, [5, 5]),
  ];
  const base = buildObservations(rows, 0.3);
  // 未来（最後の試合）の結果と内容を書き換えても、それより前の観測は 1 ビットも変わらない
  const changed = buildObservations([...rows.slice(0, 3), row("2026-01-22", "B", "A", 9, 0, [0, 9])], 0.3);
  assert.deepEqual(changed.slice(0, 3), base.slice(0, 3));
  // 直近 3 試合が揃うのは 4 試合目から
  assert.equal(base[3]!.luckDiff !== null, true);
  assert.equal(base[2]!.luckDiff, null);
  // 休養日の差: 両チームとも前の試合から 7 日 → 差 0
  assert.equal(base[1]!.restDiff, 0);
  assert.equal(base[0]!.restDiff, null);
});

test("parsePriceCsv / bestPriceBets: Pinnacle・平均・最高値が揃う試合だけ読み、補正後の得な結果だけを買う", () => {
  const csv = [
    "Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA,AvgH,AvgD,AvgA,MaxH,MaxD,MaxA,PSCH,PSCD,PSCA",
    "E0,01/01/2025,A,B,2,0,1.50,4.20,7.00,1.48,4.10,6.80,1.60,4.40,7.50,1.45,4.30,7.40",
    "E0,02/01/2025,C,D,0,0,,,,2.0,3.3,3.9,2.1,3.5,4.1,,,",
  ].join("\n");
  const rows = parsePriceCsv(csv, "E0", "2425");
  assert.equal(rows.length, 1); // Pinnacle の無い 2 行目は落とす
  assert.equal(rows[0]!.outcome, 0);
  const s = bestPriceBets(rows, "ps", 1.11, 0);
  assert.ok(s.n >= 1);
  assert.ok(fitGamma([{ p: [0.7, 0.18, 0.12], outcome: 0 }]) > 1); // 本命が来たら γ は大きい側へ
});
