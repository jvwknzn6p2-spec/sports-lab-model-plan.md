/**
 * 固定の基準の不変条件（Founder 指示 2026-10-09）。
 *  1. 凍結データが 1 バイトでも変われば測らない
 *  2. 予想は「試合日の 2 日前まで」の試合だけで学習する（未来の結果を変えても過去の予想は変わらない）
 *  3. 採点は 1 つの年だけ（別の年が混ざれば止まる）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK, benjaminiHochberg, compareYear, loadBenchmark, predictYear, scoreYear, type BenchRow } from "../src/benchmark.ts";

const benchDir = fileURLToPath(new URL("../../../football/benchmark/v1", import.meta.url));

test("凍結データ: sha256 と件数が一致する・書き換えれば読み込みを拒否する", () => {
  const rows = loadBenchmark(benchDir);
  assert.equal(rows.length, BENCHMARK.rows);
  assert.deepEqual([...BENCHMARK.years], ["2024", "2025", "2026"]);
  assert.ok(rows.every((r) => r.date <= BENCHMARK.until));
  const d = mkdtempSync(join(tmpdir(), "bench-"));
  cpSync(benchDir, d, { recursive: true });
  const f = join(d, BENCHMARK.file);
  writeFileSync(f, readFileSync(f, "utf8").replace('"homeGoals":1', '"homeGoals":2'));
  assert.throws(() => loadBenchmark(d), /凍結時と違う/);
});

test("リーク: ある試合の結果を変えても、その 2 日後より前の予想は 1 ビットも変わらない", () => {
  // E0 の 2026 年 1 月前半だけで回す（速さのため）
  const rows = loadBenchmark(benchDir).filter((r) => r.division === "E0" && r.date <= "2026-01-12");
  const target = rows.filter((r) => r.date >= "2026-01-03").sort((a, b) => a.date.localeCompare(b.date))[0]!;
  const changed: BenchRow[] = rows.map((r) => (r === target ? { ...r, homeGoals: r.homeGoals + 5 } : r));
  const a = predictYear(rows, "2026");
  const b = predictYear(changed, "2026");
  const limit = new Date(Date.parse(`${target.date}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  // 比べるのは予想（確率と学習の範囲）だけ。行には採点用にその試合の結果も載っている
  const before = (xs: typeof a) => xs.filter((p) => p.date < limit).map((p) => ({ k: `${p.date} ${p.home}-${p.away}`, p: p.p, trainedUntil: p.trainedUntil }));
  assert.ok(before(a).length > 0);
  assert.deepEqual(before(a), before(b));
  for (const p of a) assert.ok(p.trainedUntil <= new Date(Date.parse(`${p.date}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10));
  // 2 日後以降の予想には効く（＝学習には入っている）
  assert.notDeepEqual(a.filter((p) => p.date >= limit).map((p) => p.p), b.filter((p) => p.date >= limit).map((p) => p.p));
});

test("採点は 1 つの年だけ: 別の年の試合が混ざれば止まる", () => {
  const p: [number, number, number] = [0.5, 0.3, 0.2];
  assert.equal(scoreYear("2024", [{ date: "2024-03-01", p, o: 0 }]).n, 1);
  assert.throws(() => scoreYear("2024", [{ date: "2024-03-01", p, o: 0 }, { date: "2025-03-01", p, o: 0 }]), /年をまたいで/);
  assert.throws(() => compareYear("2025", [{ date: "2024-12-31", a: p, b: p, o: 1 }]), /年をまたいで/);
});

test("Benjamini–Hochberg: 偶然の p 値の山からは何も拾わず、本物だけを拾う", () => {
  const noise = Array.from({ length: 100 }, (_, i) => (i + 0.5) / 100);
  assert.equal(benjaminiHochberg(noise, 0.1).filter(Boolean).length, 0);
  const withReal = [0.0001, 0.0004, ...noise.slice(2)];
  assert.deepEqual(benjaminiHochberg(withReal, 0.1).slice(0, 3), [true, true, false]);
});
