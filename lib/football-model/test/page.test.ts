/**
 * 公開ページの不変条件。
 *
 * このページは商品そのもの（note / X から見に来る唯一の URL）なので、壊れても
 * CI 以外に気付く人がいない。固定するのは次の 4 点:
 *  1. **サッカー専用**（野球の台帳を読む経路を持たない）
 *  2. **モデルと市場は同じ集合で比べる**（別々の母集団の平均を並べない）
 *  3. **状態色の規定**（シアン = モデル予想 / 緑 = 的中 / 赤 = 外れ・黄色は使わない）
 *  4. **注意書きの文面は呼び出し側が丸ごと持つ**（テンプレート側に見出しを固定しない）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EN_TO_KANA, LEAGUE, kanaTable, leagueLabel } from "../src/page/labels.ts";
import { renderPage, type RenderInput } from "../src/page/render.ts";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "../src/ledger.ts";

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

const match = (providerId: string, home: string, away: string, kickoffAt: string): LedgerMatch => ({
  providerId, league: "E0", kickoffAt, cutoffAt: kickoffAt, home, away, recordedAt: kickoffAt,
});

const prediction = (
  id: string,
  providerId: string,
  kickoffAt: string,
  p: [number, number, number],
  market: [number, number, number] | null = null,
): LedgerPrediction => ({
  id, providerId, league: "E0", kickoffAt, cutoffAt: kickoffAt, publishedAt: kickoffAt,
  model: "dc-v5-shots", asOf: kickoffAt, nTrain: 400,
  pHome: p[0], pDraw: p[1], pAway: p[2], lambdaHome: 1.4, lambdaAway: 1.1,
  market, marketFetchedAt: market ? kickoffAt : null, fingerprint: "x".repeat(16),
});

const evaluation = (
  predictionId: string, providerId: string, result: "H" | "D" | "A",
  rps: number, marketRps: number | null,
): LedgerEvaluation => ({
  predictionId, providerId, league: "E0", result, homeGoals: 1, awayGoals: 0,
  rps, brier: rps, logloss: rps, marketRps, evaluatedAt: "2026-09-01T00:00:00Z",
});

const render = (over: Partial<RenderInput> = {}) =>
  renderPage({
    predictions: [], matches: [], evaluations: [],
    publishedProviderIds: new Set(), isPreview: false,
    now: new Date("2026-09-23T00:00:00Z"),
    ...over,
  });

test("台帳はサッカーのみ — 野球の台帳・リポジトリを指す経路を持たない", () => {
  for (const rel of ["page/render.ts", "page/labels.ts", "cli/page.ts"]) {
    const text = src(rel);
    // 「野球は混ぜない」は本文の説明にも出るので、**読み込み経路**だけを見る
    const reads = text.match(/readFileSync\([^)]*\)|readNdjson<[^>]*>\([^)]*\)/g) ?? [];
    for (const r of reads) {
      assert.ok(!/mlb|npb|handiedge/i.test(r), `野球の台帳を読む経路: ${rel} ${r}`);
    }
    // 環境に固有の絶対パスを焼き込まない（スクラッチパッド時代の名残を戻さない）
    assert.ok(!/["'`]\/(home|tmp)\//.test(text), `絶対パスが焼き込まれている: ${rel}`);
  }
  // 既定の台帳は football/ledger のみ
  assert.match(src("cli/page.ts"), /"football\/ledger"/);
});

test("モデルと市場は同じ集合で比べる", () => {
  // 市場のある 2 件（モデル 0.20 / 市場 0.10）と、市場の無い 1 件（モデル 0.60）。
  // 全決着で平均すると 0.333 になり、市場の 0.100 と並べると別の母集団の比較になる。
  const matches = [
    match("p1", "Arsenal", "Chelsea", "2026-09-01T12:00:00Z"),
    match("p2", "Liverpool", "Everton", "2026-09-02T12:00:00Z"),
    match("p3", "Fulham", "Brentford", "2026-09-03T12:00:00Z"),
  ];
  const predictions = [
    prediction("e1", "p1", "2026-09-01T12:00:00Z", [0.5, 0.3, 0.2], [0.5, 0.3, 0.2]),
    prediction("e2", "p2", "2026-09-02T12:00:00Z", [0.5, 0.3, 0.2], [0.5, 0.3, 0.2]),
    prediction("e3", "p3", "2026-09-03T12:00:00Z", [0.5, 0.3, 0.2]),
  ];
  const evaluations = [
    evaluation("e1", "p1", "H", 0.2, 0.1),
    evaluation("e2", "p2", "H", 0.2, 0.1),
    evaluation("e3", "p3", "H", 0.6, null),
  ];
  const { html, stats } = render({ matches, predictions, evaluations });
  assert.equal(stats.settled, 3);
  // 見出しは「市場と同じ N 件」と件数を明示し、両者をその集合の平均で出す
  assert.match(html, /市場と同じ 2 件で比べると モデル 0\.200 対 市場 0\.100/);
  // 全決着の平均（0.333）を市場と並べていない
  assert.ok(!/モデル 0\.333 対 市場/.test(html));
});

test("的中・外れは規定の状態色を使い、黄色・ゴールドは使わない", () => {
  const { html } = render({
    matches: [match("p1", "Arsenal", "Chelsea", "2026-09-01T12:00:00Z")],
    predictions: [prediction("e1", "p1", "2026-09-01T12:00:00Z", [0.5, 0.3, 0.2])],
    evaluations: [evaluation("e1", "p1", "H", 0.2, 0.1)],
  });
  assert.match(html, /chip hit">的中/);
  assert.match(html, /\.chip\.hit\{color:var\(--green\)/);
  assert.match(html, /\.chip\.miss\{color:var\(--red\)/);
  assert.ok(!/gold|yellow/i.test(html), "黄色・ゴールドは使わない");
  // 16 進の色も走査する。黄〜金の色相（40°〜70°）で彩度のある色を禁じる
  for (const hex of html.match(/#[0-9a-f]{6}\b/gi) ?? []) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 0.15) continue; // 無彩色
    let hue = 0;
    if (max === r) hue = 60 * (((g - b) / (max - min) + 6) % 6);
    else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
    else hue = 60 * ((r - g) / (max - min) + 4);
    assert.ok(hue < 40 || hue > 70, `黄〜金の色相が入っている: ${hex}（hue ${hue.toFixed(0)}）`);
  }
});

test("注意書きは渡した文面をそのまま出す — テンプレート側に見出しを固定しない", () => {
  // 2026-09-22 の公開版は「結果の取込が止まっています。」がテンプレートに固定されており、
  // 正常を伝える文を渡すと「止まっています／正常に動いています」と矛盾した
  const { html } = render({ notice: "<b>正常に動いています。</b>次節は 10/09。", noticeTone: "info" });
  assert.match(html, /<b>正常に動いています。<\/b>次節は 10\/09。/);
  assert.ok(!/止まっています/.test(html));
  assert.match(html, /class="notice info"/);
  // 既定（alert）は赤のまま
  assert.match(render({ notice: "止まっています" }).html, /class="notice "/);
  // 渡さなければ出さない
  assert.ok(!/class="notice/.test(render().html));
});

test("試算は必ず「台帳未発行」と表示する", () => {
  const over = {
    matches: [match("p1", "Arsenal", "Chelsea", "2026-10-01T12:00:00Z")],
    predictions: [prediction("e1", "p1", "2026-10-01T12:00:00Z", [0.5, 0.3, 0.2])],
  };
  const previewed = render({ ...over, isPreview: true, publishedProviderIds: new Set() });
  assert.match(previewed.html, /試算・台帳未発行/);
  const published = render({ ...over, isPreview: true, publishedProviderIds: new Set(["p1"]) });
  assert.ok(!/試算・台帳未発行/.test(published.html));
});

test("チーム名は推測で埋めず、取りこぼしを報告する", () => {
  const t = kanaTable();
  assert.equal(t.kana("Arsenal"), "アーセナル");
  assert.equal(t.kana("Nowhere United"), "Nowhere United");
  assert.deepEqual([...t.unmapped], ["Nowhere United"]);
  const { stats } = render({
    matches: [match("p1", "Nowhere United", "Arsenal", "2026-10-01T12:00:00Z")],
    predictions: [prediction("e1", "p1", "2026-10-01T12:00:00Z", [0.5, 0.3, 0.2])],
  });
  assert.deepEqual(stats.unmapped, ["Nowhere United"]);
});

test("日次が出す 10 リーグすべてに日本語名がある", () => {
  for (const code of ["E0", "I1", "SP1", "D1", "N1", "F1", "P1", "B1", "SC0", "JAP"]) {
    assert.ok(LEAGUE[code], `リーグ名が無い: ${code}`);
  }
  // 未知のコードはコードのまま出す（落とさない・推測しない）
  assert.equal(leagueLabel("ZZ9"), "ZZ9");
  assert.ok(Object.keys(EN_TO_KANA).length > 150);
});
