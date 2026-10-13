/**
 * チャンピオンズリーグ（Founder 指示 2026-10-13「市場基盤だけで記録」）を CLI ごと通す。
 * 日程（Odds API）→ 市場基盤だけを発行（正準は出さない）→ 結果（Odds API scores）→ 決済 → ページ。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPage } from "../src/page/render.ts";

const CLI = new URL("../src/cli/football.ts", import.meta.url).pathname;
const run = (args: string[]): string => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { encoding: "utf8" });
const nd = (p: string): any[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const SPORT = "soccer_uefa_champs_league";
const book = (key: string, h: number, d: number, a: number, home: string, away: string) => ({
  key,
  markets: [{ key: "h2h", outcomes: [{ name: home, price: h }, { name: "Draw", price: d }, { name: away, price: a }] }],
});

test("CL: 市場基盤だけを発行し、正準は出さない・国内の履歴に居るチームはその表記へ寄せる・決済まで通る", () => {
  const root = mkdtempSync(join(tmpdir(), "cl-"));
  const cache = join(root, "cache");
  mkdirSync(join(root, "history"), { recursive: true });
  // 国内リーグの履歴（アーセナルだけ居る）。CL の "Arsenal" はこの表記へ、"Galatasaray" はそのまま
  writeFileSync(
    join(root, "history", "E0.ndjson"),
    JSON.stringify({ division: "E0", date: "2026-10-04", time: "14:00", home: "Arsenal", away: "Chelsea", homeGoals: 1, awayGoals: 0, odds: null, source: "test", observedAt: "2026-10-05T00:00:00Z" }) + "\n",
  );
  mkdirSync(join(cache, "odds", SPORT), { recursive: true });
  const ev = { id: "clev1", sport_key: SPORT, commence_time: "2026-10-21T19:00:00Z", home_team: "Arsenal", away_team: "Galatasaray" };
  writeFileSync(
    join(cache, "odds", SPORT, "20261020T020000Z.json"),
    JSON.stringify([{ ...ev, bookmakers: [book("b1", 1.5, 4.2, 6.5, "Arsenal", "Galatasaray"), book("b2", 1.55, 4.0, 6.0, "Arsenal", "Galatasaray"), book("b3", 1.52, 4.3, 6.2, "Arsenal", "Galatasaray")] }]),
  );
  const out = run(["daily", "--root", root, "--cache", cache, "--history", join(root, "history"), "--leagues", "CL", "--now", "2026-10-20T03:00:00Z"]);
  assert.match(out, /published \(市場基盤のみ\) Arsenal v Galatasaray/);

  const canon = nd(join(root, "ledger", "predictions.ndjson"));
  const mkt = nd(join(root, "ledger", "predictions.mkt.ndjson"));
  assert.equal(canon.length, 0, "CL に正準を出している");
  assert.equal(mkt.length, 1);
  assert.equal(mkt[0].model, "mkt-only-v1");
  assert.equal(mkt[0].league, "CL");
  assert.deepEqual(mkt[0].weights, { a: 1, b: 0, c: 0 });
  // 恒等の係数 → 確率は市場そのもの
  assert.ok(Math.abs(mkt[0].pHome - mkt[0].market[0]) < 2e-4);

  // 試合後: scores が必要な競技に CL が出る（市場基盤の台帳の未決済を数える）
  const need = run(["scores-needed", "--root", root, "--leagues", "CL", "--now", "2026-10-22T03:00:00Z"]);
  assert.equal(need.trim(), SPORT);

  mkdirSync(join(cache, "scores", SPORT), { recursive: true });
  writeFileSync(
    join(cache, "scores", SPORT, "20261022T030000Z.json"),
    JSON.stringify([{ ...ev, completed: true, scores: [{ name: "Arsenal", score: "2" }, { name: "Galatasaray", score: "2" }], last_update: "2026-10-21T21:00:00Z" }]),
  );
  run(["daily", "--root", root, "--cache", cache, "--history", join(root, "history"), "--leagues", "CL", "--now", "2026-10-22T03:00:00Z"]);
  const evs = nd(join(root, "ledger", "evaluations.mkt.ndjson"));
  assert.equal(evs.length, 1, "決済されない");
  assert.equal(evs[0].result, "D");
  assert.equal(nd(join(root, "ledger", "evaluations.ndjson")).length, 0);

  // ページ: 行は出るが、正準の集計（決着の的中・RPS）には入らない
  const matches = nd(join(root, "ledger", "matches.ndjson"));
  const r = renderPage({ predictions: [], matches, evaluations: [], publishedProviderIds: new Set(), isPreview: false, now: new Date("2026-10-22T03:00:00Z"), mktPredictions: mkt, mktEvaluations: evs });
  assert.match(r.html, /チャンピオンズリーグ/);
  assert.match(r.html, /市場基盤のみ（正準は対象外）/);
  assert.match(r.html, /アーセナル/);
  assert.equal(r.stats.settled, 0, "大会の行を正準の決着に数えている");
});

test("ワークフロー: CL の odds は無料の /events で試合がある日だけ取る・結果は fdorg CL", () => {
  const wf = readFileSync(new URL("../../../.github/workflows/football-daily.yml", import.meta.url), "utf8");
  assert.match(wf, /sport=soccer_uefa_champs_league\n/);
  assert.match(wf, /\$sport\/events\?/);
  assert.match(wf, /for comp in PL BL1 SA PD FL1 PPL DED CL; do/);
  assert.match(wf, /daily --root football --cache football\/cache --leagues [^\n]*,CL\b/);
});
