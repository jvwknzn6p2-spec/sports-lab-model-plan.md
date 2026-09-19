/**
 * 無料の市場オッズ（football-data.co.uk の fixtures.csv）。
 *
 * **リポジトリ内の実サンプルで検査する**（`fixtures/fd-fixtures.csv`・probe 2026-09-02 取得）。
 * 合成データだけで通すと、列名や書式が実物とずれていても気付けない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FixtureMarketIndex, marketFromRow, parseFixturesCsv } from "../src/footballDataFixtures.ts";

const real = readFileSync(new URL("../fixtures/fd-fixtures.csv", import.meta.url), "utf8");

test("実サンプル: 全行を読み、全行に市場が付く", () => {
  const fx = parseFixturesCsv(real);
  assert.equal(fx.length, 48, "行数が実サンプルと違う");
  assert.equal(fx.filter((f) => f.market).length, 48, "市場が付かない行がある");
  const f = fx[0];
  assert.equal(f.division, "B1");
  assert.equal(f.dateLocal, "2026-09-02");
  assert.equal(f.timeLocal, "19:30");
  assert.equal(f.home, "St Truiden");
  assert.equal(f.away, "St. Gilloise");
  assert.ok(f.books >= 5, `ブック数 ${f.books} が少なすぎる`);
});

test("実サンプル: J1（JPN）は収録されていない", () => {
  // football-data の「追加リーグ」は fixtures.csv に出ない。J1 に無料のオッズ源は無い
  const fx = parseFixturesCsv(real);
  assert.equal(fx.filter((f) => f.division === "JPN" || f.division === "JAP").length, 0);
});

test("確率は 1 に正規化され、控除率が抜けている", () => {
  const fx = parseFixturesCsv(real);
  for (const f of fx) {
    const [h, d, a] = f.market!;
    assert.ok(Math.abs(h + d + a - 1) < 1e-9, `合計が 1 でない: ${h + d + a}`);
    assert.ok(h > 0 && d > 0 && a > 0, "非正の確率");
  }
});

test("控除率はブックごとに抜く（Odds API と同じ手順）", () => {
  // 1 社だけ・控除率 10% のオッズ。正規化後はぴったり 0.5/0.25/0.25 になる
  const { market, books } = marketFromRow({ B365H: "1.8", B365D: "3.6", B365A: "3.6" });
  assert.equal(books, 1);
  const [h, d, a] = market!;
  assert.ok(Math.abs(h - 0.5) < 1e-9, `${h}`);
  assert.ok(Math.abs(d - 0.25) < 1e-9, `${d}`);
  assert.ok(Math.abs(a - 0.25) < 1e-9, `${a}`);
});

test("Max / Avg は使わない（派生値であって 1 社の建値ではない）", () => {
  const { market, books } = marketFromRow({ MaxH: "2.0", MaxD: "4.0", MaxA: "4.0", AvgH: "1.9", AvgD: "3.5", AvgA: "3.9" });
  assert.equal(books, 0);
  assert.equal(market, null);
});

test("読めない行は捨てる（推測で埋めない）", () => {
  const csv = [
    "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A",
    "E0,not-a-date,15:00,Arsenal,Chelsea,2.0,3.5,4.0", // 日付が読めない
    "E0,19/09/2026,15:00,,Chelsea,2.0,3.5,4.0", // ホームが空
    "E0,19/09/2026,15:00,Arsenal,Chelsea,,,", // オッズ無し（行は残るが market は null）
    "E0,19/09/2026,15:00,Leeds,Everton,2.0,3.5,4.0", // 正常
  ].join("\n");
  const fx = parseFixturesCsv(csv);
  assert.equal(fx.length, 2, "捨てるべき行が残っている");
  assert.equal(fx[0].market, null, "オッズ無しを埋めている");
  assert.ok(fx[1].market);
});

test("索引: 同じ対戦を日付 ±1 日で引く（英国現地日付と UTC のずれ）", () => {
  const idx = new FixtureMarketIndex(parseFixturesCsv(real));
  // 実サンプルの 1 件（B1 St Truiden v St. Gilloise・現地 09-02）
  assert.ok(idx.find("B1", "St Truiden", "St. Gilloise", "2026-09-02T18:30:00Z"), "同日が引けない");
  assert.ok(idx.find("B1", "St Truiden", "St. Gilloise", "2026-09-03T00:30:00Z"), "翌日（深夜開催）が引けない");
  assert.ok(idx.find("B1", "St Truiden", "St. Gilloise", "2026-09-01T22:00:00Z"), "前日が引けない");
  assert.equal(idx.find("B1", "St Truiden", "St. Gilloise", "2026-09-05T18:30:00Z"), null, "3 日離れた試合を引いている");
  assert.equal(idx.find("E0", "St Truiden", "St. Gilloise", "2026-09-02T18:30:00Z"), null, "リーグ違いを引いている");
  assert.equal(idx.find("B1", "St. Gilloise", "St Truiden", "2026-09-02T18:30:00Z"), null, "ホームとアウェイを取り違えている");
});

test("索引: 市場の無い行は引かない（null を返すのではなく索引に入れない）", () => {
  const idx = new FixtureMarketIndex(parseFixturesCsv(
    "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A\nE0,19/09/2026,15:00,Leeds,Everton,,,",
  ));
  assert.equal(idx.size, 0);
  assert.equal(idx.find("E0", "Leeds", "Everton", "2026-09-19T14:00:00Z"), null);
});
