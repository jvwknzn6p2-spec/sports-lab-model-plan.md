/**
 * 同じ試合の二重登録（fixtureIdentity.ts）。2026-09-25 に台帳で実測した 3 つの型を
 * そのまま再現する:
 *   - 前倒し（Sevilla–Valencia）: 実試合 9/11、古い登録 9/13 に試合後の予想が立った
 *   - 前倒し（Osasuna–Espanol）: 実試合 9/12、古い登録 9/13 に実試合の封緘後の予想
 *   - 後ろ倒し（Torino–Roma）: 古い登録 9/13 と実試合 9/14 の両方に予想・両方決済
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, cutoffOf, type LedgerMatch, type LedgerPrediction } from "../src/ledger.ts";
import type { MarketFixture } from "../src/oddsApi.ts";
import type { MatchWithOdds } from "../src/footballData.ts";

const fixture = (providerId: string, league: string, kickoffAt: string, home: string, away: string): MarketFixture => ({
  provider: "the-odds-api", providerId, sportKey: "soccer", kickoffAt, home, away, resolved: true, bookmakers: 0, market: null,
});
const resultRow = (division: string, home: string, away: string, date: string, homeGoals: number, awayGoals: number): MatchWithOdds => ({
  division, date, home, away, homeGoals, awayGoals, odds: null,
});
import { countedPredictions, fixtureRegistrations, sameFixture } from "../src/fixtureIdentity.ts";
import { renderSummary } from "../src/pipeline.ts";
import { ingestLevel, resultsExpected } from "../src/health.ts";

const match = (providerId: string, kickoffAt: string, home = "Sevilla", away = "Valencia"): LedgerMatch => ({
  providerId,
  league: "SP1",
  kickoffAt,
  cutoffAt: cutoffOf(kickoffAt),
  home,
  away,
  recordedAt: "2026-09-03T01:39:34.348Z",
});

const pred = (id: string, m: LedgerMatch, publishedAt: string): LedgerPrediction => ({
  id,
  providerId: m.providerId,
  league: m.league,
  kickoffAt: m.kickoffAt,
  cutoffAt: m.cutoffAt,
  publishedAt,
  model: "dc-v1",
  asOf: publishedAt,
  nTrain: 1500,
  pHome: 0.5,
  pDraw: 0.25,
  pAway: 0.25,
  lambdaHome: 1.4,
  lambdaAway: 1.1,
  market: null,
  marketFetchedAt: null,
  fingerprint: id,
});

test("同じ試合: 同じリーグ・同じ本拠地・7 日以内。1 週間を超えれば別の試合", () => {
  const a = match("a", "2026-09-11T19:00:00Z");
  assert.equal(sameFixture(a, match("b", "2026-09-13T19:00:00Z")), true);
  assert.equal(sameFixture(a, match("c", "2026-09-18T19:00:00Z")), true); // ちょうど 7 日
  assert.equal(sameFixture(a, match("d", "2026-09-18T19:00:01Z")), false);
  assert.equal(sameFixture(a, match("e", "2026-09-13T19:00:00Z", "Valencia", "Sevilla")), false); // 本拠地が逆
});

test("前倒し: 実試合の後に古い登録へ出た予想は数えない（Sevilla–Valencia）", () => {
  const real = match("real", "2026-09-11T19:00:00Z");
  const stale = match("stale", "2026-09-13T19:00:00Z");
  const matches = new Map([real, stale].map((m) => [m.providerId, m]));
  const c = countedPredictions(
    [pred("p-real", real, "2026-09-10T00:05:00Z"), pred("p-stale", stale, "2026-09-12T00:08:42Z")],
    matches,
  );
  assert.deepEqual([...c.counted], ["p-real"]);
  assert.match(c.excluded.get("p-stale")!, /封緘 2026-09-11T11:00:00.000Z より後/);
});

test("前倒し: 実試合の封緘後・キックオフ前でも 2 本目は数えない（Osasuna–Espanol）", () => {
  const real = match("real", "2026-09-12T14:15:00Z", "Osasuna", "Espanol");
  const stale = match("stale", "2026-09-13T19:00:00Z", "Osasuna", "Espanol");
  const c = countedPredictions(
    [pred("p1", real, "2026-09-11T00:00:00Z"), pred("p2", stale, "2026-09-12T00:08:42Z")],
    new Map([real, stale].map((m) => [m.providerId, m])),
  );
  assert.deepEqual([...c.counted], ["p1"]);
  assert.equal(c.excluded.size, 1);
});

test("後ろ倒し: 早い登録の封緘より前に出た予想 1 本だけを数える（Torino–Roma）", () => {
  const stale = match("stale", "2026-09-13T10:30:00Z", "Torino", "Roma");
  const real = match("real", "2026-09-14T16:30:00Z", "Torino", "Roma");
  const c = countedPredictions(
    [pred("early", stale, "2026-09-12T00:08:42Z"), pred("late", real, "2026-09-12T23:55:46Z")],
    new Map([stale, real].map((m) => [m.providerId, m])),
  );
  // 9/13 10:30 の封緘（9/12 11:00Z）より前に出たのは early だけ
  assert.deepEqual([...c.counted], ["early"]);
  assert.ok(c.excluded.has("late"));
});

test("封緘前の 2 本がある場合は早く出た方を数える", () => {
  const a = match("a", "2026-09-20T19:00:00Z");
  const b = match("b", "2026-09-21T19:00:00Z");
  const c = countedPredictions(
    [pred("second", b, "2026-09-15T00:00:00Z"), pred("first", a, "2026-09-14T00:00:00Z")],
    new Map([a, b].map((m) => [m.providerId, m])),
  );
  assert.deepEqual([...c.counted], ["first"]);
  assert.match(c.excluded.get("second")!, /2 本目/);
});

test("封緘が読めない行でも落ちず、封緘後とは判定しない", () => {
  const a = { ...match("a", "2026-09-20T19:00:00Z"), cutoffAt: "" };
  const c = countedPredictions([{ ...pred("p", a, "2026-09-14T00:00:00Z"), cutoffAt: "" }], new Map([[a.providerId, a]]));
  assert.deepEqual([...c.counted], ["p"]);
});

test("登録が 1 つだけの試合は従来どおり数える", () => {
  const a = match("a", "2026-09-20T19:00:00Z");
  const c = countedPredictions([pred("p", a, "2026-09-14T00:00:00Z")], new Map([[a.providerId, a]]));
  assert.deepEqual([...c.counted], ["p"]);
  assert.equal(c.excluded.size, 0);
});

test("発行: 同じ試合に別登録の予想があれば拒否し、封緘は最も早い登録のものを使う", () => {
  const L = new Ledger(mkdtempSync(join(tmpdir(), "ledger-fx-")));
  const f = (providerId: string, kickoffAt: string) => fixture(providerId, "SP1", kickoffAt, "Sevilla", "Valencia");
  // 二重登録は recordFixtures（±1 日）をすり抜ける 2 日差で入れる
  assert.equal(L.recordFixtures([f("real", "2026-09-11T19:00:00Z"), f("stale", "2026-09-13T19:00:00Z")], "SP1", "2026-09-03T01:39:34Z").added, 2);
  const base = { league: "SP1", model: "dc-v1", nTrain: 1500, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.4, lambdaAway: 1.1, market: null, marketFetchedAt: null };
  // 実試合の封緘（9/11 11:00Z）より後: 古い登録の封緘（9/13 11:00Z）より前でも拒否
  const late = L.publishPrediction({ ...base, providerId: "stale", kickoffAt: "2026-09-13T19:00:00Z", publishedAt: "2026-09-12T00:08:42Z", asOf: "2026-09-12T00:08:42Z" });
  assert.equal(late.ok, false);
  assert.match((late as { reason: string }).reason, /earlier registration of the same fixture/);
  // 実試合の封緘前なら出せる。その後、もう一方の登録には出せない
  assert.equal(L.publishPrediction({ ...base, providerId: "real", kickoffAt: "2026-09-11T19:00:00Z", publishedAt: "2026-09-10T00:05:00Z", asOf: "2026-09-10T00:05:00Z" }).ok, true);
  const twin = L.publishPrediction({ ...base, providerId: "stale", kickoffAt: "2026-09-13T19:00:00Z", publishedAt: "2026-09-10T00:06:00Z", asOf: "2026-09-10T00:06:00Z" });
  assert.equal(twin.ok, false);
  assert.match((twin as { reason: string }).reason, /already published for the same fixture/);
});

test("決済: 延期（後ろ倒し）は 7 日まで追い、前倒しの結果には結ばない", () => {
  const L = new Ledger(mkdtempSync(join(tmpdir(), "ledger-pp-")));
  L.recordFixtures(
    [fixture("utr", "N1", "2026-09-05T16:45:00Z", "Utrecht", "Go Ahead Eagles"), fixture("ajx", "N1", "2026-09-13T19:00:00Z", "Ajax", "PSV")],
    "N1",
    "2026-09-03T00:00:00Z",
  );
  const base = { league: "N1", model: "dc-v1", nTrain: 900, pHome: 0.4, pDraw: 0.3, pAway: 0.3, lambdaHome: 1.3, lambdaAway: 1.1, market: null, marketFetchedAt: null };
  assert.ok(L.publishPrediction({ ...base, providerId: "utr", kickoffAt: "2026-09-05T16:45:00Z", publishedAt: "2026-09-04T07:54:34Z", asOf: "2026-09-04T07:54:34Z" }).ok);
  assert.ok(L.publishPrediction({ ...base, providerId: "ajx", kickoffAt: "2026-09-13T19:00:00Z", publishedAt: "2026-09-12T00:00:00Z", asOf: "2026-09-12T00:00:00Z" }).ok);
  // Utrecht は 3 日後に開催（延期）、Ajax は 2 日前に開催（前倒し）
  L.recordResults(
    [resultRow("N1", "Utrecht", "Go Ahead Eagles", "2026-09-08", 3, 3), resultRow("N1", "Ajax", "PSV", "2026-09-11", 1, 0)],
    "football-data.co.uk",
    "2026-09-14T00:00:00Z",
  );
  assert.equal(L.settle("2026-09-14T00:00:00Z"), 1);
  const ev = L.evaluations();
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.providerId, "utr");
  assert.equal(ev[0]!.result, "D");
});

test("取込の沈黙: 最新の試合日より後にキックオフした登録が無ければ故障と数えない", () => {
  const h = { lastRecordedAt: "2026-09-23T00:20:16Z", hoursSinceRecord: 96, lastMatchDate: "2026-09-20", results: 554 };
  // 代表ウィーク: 次の登録は 10/10 以降 → 結果が来ないのは正常
  const breakWeek = resultsExpected(["2026-09-20T19:30:00Z", "2026-10-10T14:00:00Z"], h.lastMatchDate, "2026-09-27T00:20:00Z");
  assert.equal(breakWeek, false);
  assert.equal(ingestLevel(h, undefined, undefined, breakWeek), "ok");
  // 9/26 に試合があったのに取れていない → 従来どおり失敗
  const live = resultsExpected(["2026-09-26T14:00:00Z"], h.lastMatchDate, "2026-09-27T00:20:00Z");
  assert.equal(live, true);
  assert.equal(ingestLevel(h, undefined, undefined, live), "fail");
  // 終わったばかり（6 時間未満）の試合は数えない
  assert.equal(resultsExpected(["2026-09-26T22:00:00Z"], h.lastMatchDate, "2026-09-27T00:20:00Z"), false);
});

// ---------------------------------------------------------------------------
// 本番台帳（football/ledger）に対する不変条件

const LEDGER = new URL("../../../football/ledger/", import.meta.url).pathname;

test("本番台帳: 数える予想は 1 試合 1 本で、全て同じ試合の最も早い封緘より前の発行", { skip: !existsSync(join(LEDGER, "predictions.ndjson")) }, () => {
  const L = new Ledger(LEDGER);
  const matches = L.currentMatches();
  const preds = L.predictions();
  const { counted, excluded } = countedPredictions(preds, matches);
  assert.equal(counted.size + excluded.size, preds.length);
  const all = [...matches.values()];
  const seen = new Map<string, string>();
  for (const p of preds.filter((x) => counted.has(x.id))) {
    const m = matches.get(p.providerId);
    if (!m) continue;
    const regs = fixtureRegistrations({ ...m, kickoffAt: p.kickoffAt }, all);
    const cutoff = Math.min(Date.parse(p.cutoffAt), ...regs.map((r) => Date.parse(r.cutoffAt)));
    assert.ok(Date.parse(p.publishedAt) < cutoff, `${p.id} は同じ試合の封緘後に発行されている`);
    const key = regs.map((r) => r.providerId).sort()[0]!;
    assert.equal(seen.get(key), undefined, `${p.id} と ${seen.get(key)} が同じ試合として両方数えられている`);
    seen.set(key, p.id);
  }
  // 2026-09-25 に実測した 5 件（行は台帳に残り、集計からは外れる）
  for (const id of ["f5d37956a3e8a488", "8b0cb89df73cb247", "963aa7edac6cd54f", "4ee4c4f32fde670b", "0009f7760e78dea2"]) {
    if (preds.some((p) => p.id === id)) assert.ok(excluded.has(id), `${id} が数えられている`);
  }
  // 要約は除外件数を明示する
  const md = renderSummary(["SP1", "I1"], preds, L.evaluations(), matches, "2026-09-25T00:00:00Z");
  assert.match(md, /件は、上の表にも下の一覧にも数えない/);
  assert.equal(readFileSync(join(LEDGER, "predictions.ndjson"), "utf8").split("\n").filter(Boolean).length, preds.length);
});
