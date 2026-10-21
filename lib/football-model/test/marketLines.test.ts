/**
 * 市場のアジアンハンデとオーバー/アンダー 2.5（fixtures.csv・無料）の記録（Founder 判断「①」2026-10-21）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFixturesCsv } from "../src/footballDataFixtures.ts";

const SAMPLE = new URL("../fixtures/fd-fixtures.csv", import.meta.url).pathname;

test("実サンプル: fixtures.csv の全行からアジアンハンデと OU2.5 を読む（ホーム側のライン・[ホーム, アウェイ]）", () => {
  const rows = parseFixturesCsv(readFileSync(SAMPLE, "utf8"));
  assert.ok(rows.length > 0);
  const withAh = rows.filter((r) => r.asian);
  assert.ok(withAh.length / rows.length > 0.9, `アジアンハンデが読めた行 ${withAh.length}/${rows.length}`);
  for (const r of withAh) {
    assert.ok(Number.isFinite(r.asian!.line) && Math.abs(r.asian!.line) <= 5, `ライン ${r.asian!.line}`);
    for (const p of [r.asian!.pinnacle, r.asian!.max, r.asian!.avg]) if (p) assert.ok(p[0] > 1 && p[1] > 1);
  }
  assert.ok(rows.filter((r) => r.ou25).length / rows.length > 0.9);
});

test("列が無い・空の行は null（推測で埋めない）", () => {
  const csv = "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A\nE0,24/10/2026,15:00,Arsenal,Everton,1.5,4.2,7\n";
  const [r] = parseFixturesCsv(csv);
  assert.equal(r!.asian, null);
  assert.equal(r!.ou25, null);
});

test("日次: 市場のハンデ線を football/lines/football-data に残し、football/market には混ぜない", () => {
  const root = mkdtempSync(join(tmpdir(), "lines-"));
  const cache = join(root, "cache");
  mkdirSync(cache, { recursive: true });
  copyFileSync(SAMPLE, join(cache, "fixtures.csv"));
  const league = parseFixturesCsv(readFileSync(SAMPLE, "utf8"))[0]!.division;
  const cli = new URL("../src/cli/football.ts", import.meta.url).pathname;
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "daily", "--root", root, "--cache", cache, "--history", join(root, "history"), "--leagues", league, "--now", "2026-09-17T00:00:00Z"], { encoding: "utf8" });
  assert.match(out, /lines: アジアンハンデ\/OU2\.5 \d+ 試合/);
  const dir = join(root, "lines", "football-data");
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const rows = JSON.parse(readFileSync(join(dir, files[0]!), "utf8"));
  assert.ok(rows.length > 0 && rows.every((r: { league: string; asian: unknown }) => r.league === league));
  assert.ok(!existsSync(join(root, "market", "football-data")), "football/market に混ぜている");
  const wf = readFileSync(new URL("../../../.github/workflows/football-daily.yml", import.meta.url), "utf8");
  assert.match(wf, /if \[ -d football\/lines \]; then git add football\/lines; fi/);
});
