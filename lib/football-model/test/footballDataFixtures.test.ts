/**
 * 無料の市場オッズ（football-data.co.uk の fixtures.csv）。
 *
 * **リポジトリ内の実サンプルで検査する**（`fixtures/fd-fixtures.csv`・probe 2026-09-02 取得）。
 * 合成データだけで通すと、列名や書式が実物とずれていても気付けない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FixtureMarketIndex, fixturesAsMatches, marketFromRow, parseFixturesCsv, ukLocalToUtc } from "../src/footballDataFixtures.ts";

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

test("英国現地時刻 → UTC（夏時間あり）", () => {
  // BST（3 月最終日曜〜10 月最終日曜）は UTC+1
  assert.equal(ukLocalToUtc("2026-09-20", "17:30"), "2026-09-20T16:30:00Z");
  assert.equal(ukLocalToUtc("2026-06-01", "15:00"), "2026-06-01T14:00:00Z");
  // GMT の期間は UTC そのもの
  assert.equal(ukLocalToUtc("2026-12-26", "15:00"), "2026-12-26T15:00:00Z");
  assert.equal(ukLocalToUtc("2026-02-01", "20:00"), "2026-02-01T20:00:00Z");
  // 切替日の当日（2026 年は 3/29 01:00Z に BST 開始・10/25 02:00 BST に終了）
  assert.equal(ukLocalToUtc("2026-03-29", "14:00"), "2026-03-29T13:00:00Z");
  assert.equal(ukLocalToUtc("2026-10-25", "14:00"), "2026-10-25T14:00:00Z");
  // 読めないものは埋めない
  assert.equal(ukLocalToUtc("2026-09-20", null), null);
  assert.equal(ukLocalToUtc("20/09/2026", "17:30"), null);
  assert.equal(ukLocalToUtc("2026-09-20", "なし"), null);
});

test("実サンプル: 全行にキックオフ（UTC）が付く", () => {
  const fx = parseFixturesCsv(real);
  assert.equal(fx.filter((f) => f.kickoffAt).length, fx.length);
  assert.equal(fx[0].kickoffAt, "2026-09-02T18:30:00Z"); // B1 09-02 19:30 英国現地
});

test("日程の取得元として使う: リーグで絞り、時刻の無い行は入れない", () => {
  const fx = parseFixturesCsv(real);
  const names = new Set(fx.flatMap((f) => [f.home, f.away]));
  const resolve = (n: string) => (names.has(n) ? n : null);
  const b1 = fixturesAsMatches(fx, "B1", resolve);
  assert.equal(b1.length, fx.filter((f) => f.division === "B1").length);
  assert.ok(b1.every((m) => m.provider === "football-data" && m.resolved && m.kickoffAt));
  assert.ok(b1.every((m) => m.providerId.startsWith("fd:B1:")));
  // 別リーグは混ざらない
  assert.equal(fixturesAsMatches(fx, "E0", resolve).every((m) => m.providerId.startsWith("fd:E0:")), true);
  // 時刻が無い行は日程にしない（封緘時刻を決められないため）
  const noTime = parseFixturesCsv(
    "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A\nE0,19/09/2026,,Leeds,Everton,2.0,3.5,4.0",
  );
  assert.equal(noTime.length, 1);
  assert.equal(fixturesAsMatches(noTime, "E0", (n) => n).length, 0);
});

test("日程の取得元: 名前が解決できない行は resolved=false で返す（捨てない）", () => {
  const fx = parseFixturesCsv(real);
  const out = fixturesAsMatches(fx, "B1", () => null);
  assert.ok(out.length > 0);
  assert.ok(out.every((m) => !m.resolved), "解決できないのに resolved=true になっている");
});
