/**
 * 市場スナップショットの索引。**キックオフ以降のオッズを拾わないこと**を固定する
 * （試合後のオッズで予想を対照したら後知恵になる）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closingBefore, closingMarketResolver, fetchedAtOfFilename, indexMarketSnapshots } from "../src/marketSnapshots.ts";

function fixture(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "market-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const row = (providerId: string, market: number[]) => ({ providerId, kickoffAt: "2026-09-19T18:00:00Z", market });

test("ファイル名から取得時刻を読む", () => {
  assert.equal(fetchedAtOfFilename("20260917T002649Z.json"), "2026-09-17T00:26:49Z");
  assert.equal(fetchedAtOfFilename("latest.json"), null);
  assert.equal(fetchedAtOfFilename("20260917T002649Z.txt"), null);
});

test("複数の競技ディレクトリを走査し、取得時刻の昇順で並べる", () => {
  const dir = fixture({
    "soccer_epl/20260917T002649Z.json": [row("a", [0.5, 0.25, 0.25])],
    "soccer_epl/20260915T000916Z.json": [row("a", [0.4, 0.3, 0.3])],
    "soccer_spl/20260916T000916Z.json": [row("b", [0.6, 0.2, 0.2])],
  });
  const idx = indexMarketSnapshots(dir);
  assert.deepEqual(idx.get("a")!.map((s) => s.fetchedAt), ["2026-09-15T00:09:16Z", "2026-09-17T00:26:49Z"]);
  assert.equal(idx.get("b")!.length, 1);
});

test("キックオフ前の最新だけを返す（試合後のオッズは使わない）", () => {
  const dir = fixture({
    "soccer_epl/20260918T000000Z.json": [row("a", [0.40, 0.30, 0.30])],
    "soccer_epl/20260919T120000Z.json": [row("a", [0.45, 0.28, 0.27])], // 直前（キックオフ 18:00Z）
    "soccer_epl/20260919T200000Z.json": [row("a", [0.90, 0.07, 0.03])], // 試合中・後
  });
  const idx = indexMarketSnapshots(dir);
  const c = closingBefore(idx, "a", "2026-09-19T18:00:00Z");
  assert.equal(c!.fetchedAt, "2026-09-19T12:00:00Z");
  assert.deepEqual(c!.market, [0.45, 0.28, 0.27]);
});

test("キックオフちょうどの取得は使わない（境界）", () => {
  const dir = fixture({ "soccer_epl/20260919T180000Z.json": [row("a", [0.5, 0.25, 0.25])] });
  assert.equal(closingBefore(indexMarketSnapshots(dir), "a", "2026-09-19T18:00:00Z"), null);
});

test("知らない providerId・スナップショットが無い場合は null", () => {
  const dir = fixture({ "soccer_epl/20260918T000000Z.json": [row("a", [0.5, 0.25, 0.25])] });
  const idx = indexMarketSnapshots(dir);
  assert.equal(closingBefore(idx, "nope", "2026-09-19T18:00:00Z"), null);
  assert.equal(closingBefore(idx, "a", "2026-09-17T00:00:00Z"), null, "全て試合後のとき");
});

test("壊れたファイル・形の違う行は飛ばし、他を巻き添えにしない", () => {
  const dir = fixture({
    "soccer_epl/20260916T000000Z.json": "{ これは JSON ではない",
    "soccer_epl/20260917T000000Z.json": { not: "an array" },
    "soccer_epl/20260918T000000Z.json": [
      { providerId: "a", market: [0.5, 0.25] }, // 3 要素でない
      { providerId: 42, market: [0.5, 0.25, 0.25] }, // providerId が文字列でない
      row("a", [0.5, 0.25, 0.25]), // これだけ正しい
    ],
  });
  const idx = indexMarketSnapshots(dir);
  assert.equal(idx.get("a")!.length, 1);
  assert.deepEqual(idx.get("a")![0].market, [0.5, 0.25, 0.25]);
});

test("ディレクトリが無くても落ちない（市場を保存していない環境）", () => {
  assert.equal(indexMarketSnapshots(join(tmpdir(), "does-not-exist-" + Date.now())).size, 0);
});

test("closingMarketResolver: 索引を 1 度だけ作って関数として渡せる", () => {
  const dir = fixture({ "soccer_epl/20260919T120000Z.json": [row("a", [0.45, 0.28, 0.27])] });
  const resolve = closingMarketResolver(dir);
  assert.equal(resolve("a", "2026-09-19T18:00:00Z")!.fetchedAt, "2026-09-19T12:00:00Z");
  assert.equal(resolve("a", "2026-09-19T11:00:00Z"), null);
});
