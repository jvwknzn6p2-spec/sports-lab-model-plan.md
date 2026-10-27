/**
 * 貼られた日本式ハンデの記録と答え合わせ（src/quotes.ts・Founder 承認 2026-10-27「①から」）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asianHomeResult, evaluateQuote, fitFromAsian, japaneseEv, marginDistribution, readQuotes, type QuoteRow } from "../src/quotes.ts";

test("アジアンハンデの決済: 0.25 刻みは半分ずつ", () => {
  assert.equal(asianHomeResult(-0.5, 1), 1);
  assert.equal(asianHomeResult(-0.5, 0), -1);
  assert.equal(asianHomeResult(-1, 1), 0);
  assert.equal(asianHomeResult(-0.75, 1), 0.5);
  assert.equal(asianHomeResult(-0.25, 0), -0.5);
  assert.equal(asianHomeResult(0.25, 0), 0.5);
  assert.equal(asianHomeResult(-1.5, 2), 1);
});

test("市場に合わせた分布: −1.5 が五分五分なら、同じ基準の 1半 は両側とも手数料ぶん（約 −5%）", () => {
  const fit = fitFromAsian({ line: -1.5, home: 1.9, away: 1.9 }, { over: 1.9, under: 1.9 });
  const { margin, over25 } = marginDistribution(fit.lh, fit.la);
  let cover = 0;
  for (const [m, p] of margin) if (m >= 2) cover += p;
  assert.ok(Math.abs(cover - 0.5) < 0.01, `ホームが 2 点差以上で勝つ確率 ${cover}`);
  assert.ok(Math.abs(over25 - 0.5) < 0.01);
  const ev = japaneseEv(margin, "1半", true);
  assert.ok(Math.abs(ev.giving + 0.05) < 0.01 && Math.abs(ev.receiving + 0.05) < 0.01, JSON.stringify(ev));
});

test("市場が無い試合は評価しない（1X2 から推測で埋めない）", () => {
  const q = { providerId: "p", givingHome: true, handicap: "0/7" } as QuoteRow;
  const r = evaluateQuote(q, new Map(), { homeGoals: 1, awayGoals: 1 });
  assert.equal(r.evGiving, null);
  assert.equal(r.share, -0.7, "決着の取り分は出す");
});

test("CLI: quote --record は quotes.ndjson に追記し、同じ貼り付けを二重に書かない・台帳には書かない", () => {
  const root = mkdtempSync(join(tmpdir(), "quotes-"));
  mkdirSync(join(root, "ledger"), { recursive: true });
  const ko = "2026-11-01T14:00:00Z";
  writeFileSync(join(root, "ledger", "matches.ndjson"), JSON.stringify({ providerId: "pid1", league: "E0", home: "Arsenal", away: "Chelsea", kickoffAt: ko, firstSeenAt: "2026-10-30T00:00:00Z", source: "test" }) + "\n");
  const paste = join(root, "paste.txt");
  writeFileSync(paste, "[プレミアリーグ]\nアーセナル<0/7>\n23:00\nチェルシー");
  const CLI = new URL("../src/cli/football.ts", import.meta.url).pathname;
  const run = () => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "quote", "--root", root, "--paste", paste, "--now", "2026-10-31T00:00:00Z", "--record"], { encoding: "utf8" });
  assert.match(run(), /記録 1 件/);
  assert.match(run(), /記録 0 件（既にあった 1 件）/);
  const qs = readQuotes(join(root, "quotes", "quotes.ndjson"));
  assert.equal(qs.length, 1);
  assert.equal(qs[0].handicap, "0/7");
  assert.equal(qs[0].givingHome, true);
  assert.equal(qs[0].pastedAt, "2026-10-31T00:00:00Z");
});
