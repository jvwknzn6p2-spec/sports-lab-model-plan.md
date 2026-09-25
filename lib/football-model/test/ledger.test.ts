import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, cutoffOf } from "../src/ledger.ts";
import { parseOddsEvents, type MarketFixture, type OddsEvent } from "../src/oddsApi.ts";
import { parseFootballDataRaw } from "../src/footballDataRaw.ts";
import { buildTeamResolver } from "../src/teamAliases.ts";

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function fresh(): Ledger {
  return new Ledger(mkdtempSync(join(tmpdir(), "ledger-")));
}

const j1 = () => {
  const names = new Set<string>();
  for (const m of parseFootballDataRaw(fx("fd-JPN.csv"), { divisions: ["JAP"] }).matches) {
    names.add(m.home);
    names.add(m.away);
  }
  return parseOddsEvents(JSON.parse(fx("odds-soccer_japan_j_league.json")) as OddsEvent[], buildTeamResolver(names));
};

test("cutoffOf: 試合日（JST）の前日 20:00 JST（= 11:00Z）", () => {
  // 9/5 10:00Z = JST 9/5 19:00 → 前日 9/4 20:00 JST
  assert.equal(cutoffOf("2026-09-05T10:00:00Z"), "2026-09-04T11:00:00.000Z");
  // 欧州の夜 9/5 19:00Z = JST 9/6 04:00 → 試合日は 9/6、封緘は 9/5 20:00 JST
  assert.equal(cutoffOf("2026-09-05T19:00:00Z"), "2026-09-05T11:00:00.000Z");
  // JST 0 時ちょうど（9/5 15:00Z = JST 9/6 00:00）は 9/6 の試合
  assert.equal(cutoffOf("2026-09-05T15:00:00Z"), "2026-09-05T11:00:00.000Z");
  assert.equal(cutoffOf("2026-09-05T14:59:59Z"), "2026-09-04T11:00:00.000Z");
});

test("日程: 解決済みだけ登録し、同じ内容は追記しない・キックオフ変更は行が増える", () => {
  const L = fresh();
  const fx1 = j1();
  assert.deepEqual(L.recordFixtures(fx1, "JAP", "2026-09-03T01:00:00Z"), { added: 10, unresolved: 0, duplicates: 0 });
  assert.deepEqual(L.recordFixtures(fx1, "JAP", "2026-09-03T02:00:00Z"), { added: 0, unresolved: 0, duplicates: 0 });
  const moved = [{ ...fx1[0], kickoffAt: "2026-09-05T11:00:00Z" }];
  assert.equal(L.recordFixtures(moved, "JAP", "2026-09-03T03:00:00Z").added, 1);
  assert.equal(L.currentMatches().get(fx1[0].providerId)!.kickoffAt, "2026-09-05T11:00:00Z");
  assert.equal(L.matches().length, 11);
});

test("日程: 同じ試合を別の providerId で二重に登録しない（取得元が 2 つになったため）", () => {
  // The Odds API のクレジットが尽きた日に無料の fixtures.csv からも日程を入れるようにした
  // （2026-09-21）。同じ試合が別 ID で 2 行入ると、1 試合に 2 つの予想が立ち、決済でも
  // 2 件として数えられる。**先に入っている方を残す**（どちらが先でも結果は同じ）
  const [f] = j1();
  const L = fresh();
  assert.equal(L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z").added, 1);
  const alias = { ...f, provider: "football-data" as const, providerId: `fd:JAP:${f.home}:${f.away}:2026-09-05` };
  assert.deepEqual(L.recordFixtures([alias], "JAP", "2026-09-03T02:00:00Z"), { added: 0, unresolved: 0, duplicates: 1 });
  assert.equal(L.matches().length, 1);

  // 逆順でも同じ（無料の日程が先に入り、後から The Odds API が同じ試合を返す）
  const L2 = fresh();
  assert.equal(L2.recordFixtures([alias], "JAP", "2026-09-03T01:00:00Z").added, 1);
  assert.equal(L2.recordFixtures([f], "JAP", "2026-09-03T02:00:00Z").duplicates, 1);
  assert.equal(L2.matches().length, 1);
  assert.equal(L2.currentMatches().get(alias.providerId)!.providerId, alias.providerId);

  // 同じ回の中で両方渡されても 1 行しか入らない
  const L3 = fresh();
  assert.deepEqual(L3.recordFixtures([f, alias], "JAP", "2026-09-03T01:00:00Z"), { added: 1, unresolved: 0, duplicates: 1 });

  // キックオフが 2 日以上離れていれば別の試合として入る（延期・再戦）
  const L4 = fresh();
  L4.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  const later = { ...alias, kickoffAt: new Date(Date.parse(f.kickoffAt) + 3 * 86_400_000).toISOString() };
  assert.equal(L4.recordFixtures([later], "JAP", "2026-09-03T02:00:00Z").added, 1);
  assert.equal(L4.matches().length, 2);
});

test("日程: 封緘規則が変わった試合は行を足して現行の cutoffAt にする（既存行は書き換えない）", () => {
  const [f] = j1();
  // 現行規則で登録済みなら、同じ内容の再取込は足さない
  const L = fresh();
  L.recordFixtures([f], "JAP", "2026-09-01T00:00:00Z");
  assert.equal(L.recordFixtures([f], "JAP", "2026-09-02T00:00:00Z").added, 0);
  assert.equal(L.matches().length, 1);
  // 旧規則（kickoff−60 分）で登録された行だけがある台帳（2026-09-08 以前の実データの形）
  const dir = mkdtempSync(join(tmpdir(), "ledger-legacy-"));
  const legacy = { providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, cutoffAt: new Date(Date.parse(f.kickoffAt) - 3_600_000).toISOString(), home: f.home, away: f.away, recordedAt: "2026-09-01T00:00:00Z" };
  appendFileSync(join(dir, "matches.ndjson"), JSON.stringify(legacy) + "\n");
  const L2 = new Ledger(dir);
  assert.equal(L2.currentMatches().get(f.providerId)!.cutoffAt, legacy.cutoffAt);
  // 同じ試合でも 1 行足されて cutoffAt が現行規則になる。旧行はそのまま残る
  assert.equal(L2.recordFixtures([f], "JAP", "2026-09-09T00:00:00Z").added, 1);
  assert.equal(L2.currentMatches().get(f.providerId)!.cutoffAt, cutoffOf(f.kickoffAt));
  assert.equal(L2.matches().length, 2);
  assert.equal(L2.matches()[0].cutoffAt, legacy.cutoffAt);
});

test("予想: 封緘前に 1 回だけ。封緘後・二重・未登録・確率不正は拒否", () => {
  const L = fresh();
  const [f] = j1();
  L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  const base = {
    providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, model: "dc-v1", asOf: "2026-09-03T01:00:00Z", nTrain: 1000,
    pHome: 0.45, pDraw: 0.27, pAway: 0.28, lambdaHome: 1.5, lambdaAway: 1.1, market: f.market, marketFetchedAt: "2026-09-03T00:57:21Z",
  };
  const r1 = L.publishPrediction({ ...base, publishedAt: "2026-09-03T03:00:00Z" });
  assert.ok(r1.ok);
  assert.equal(r1.row.cutoffAt, "2026-09-04T11:00:00.000Z"); // 9/5 10:00Z（JST 9/5 19:00）→ 前日 20:00 JST
  assert.match(r1.row.fingerprint, /^[0-9a-f]{64}$/);
  const dup = L.publishPrediction({ ...base, publishedAt: "2026-09-03T04:00:00Z" });
  assert.deepEqual(dup, { ok: false, reason: "already published" });
  const L2 = fresh();
  L2.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  assert.equal((L2.publishPrediction({ ...base, publishedAt: "2026-09-04T11:00:00.000Z" }) as { reason: string }).reason.slice(0, 6), "sealed");
  assert.equal((L2.publishPrediction({ ...base, providerId: "nope", publishedAt: "2026-09-03T03:00:00Z" }) as { reason: string }).reason, "match not registered");
  assert.equal((L2.publishPrediction({ ...base, pHome: 0.5, publishedAt: "2026-09-03T03:00:00Z" }) as { reason: string }).reason, "probabilities do not sum to 1");
  assert.equal(L2.predictions().length, 0);
});

test("結果と決済: 結果が来た予想だけ決済し、二重決済しない。市場 RPS も残す", () => {
  const L = fresh();
  const [f] = j1(); // Avispa Fukuoka v Mito, 2026-09-05 10:00Z
  L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  L.publishPrediction({
    providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, publishedAt: "2026-09-03T03:00:00Z", model: "dc-v1", asOf: "2026-09-03T01:00:00Z", nTrain: 1000,
    pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.6, lambdaAway: 1.0, market: f.market, marketFetchedAt: "2026-09-03T00:57:21Z",
  });
  assert.equal(L.settle("2026-09-06T00:00:00Z"), 0); // 結果なし
  const n = L.recordResults(
    [{ division: "JAP", date: "2026-09-05T19:00:00Z", home: "Avispa Fukuoka", away: "Mito", homeGoals: 2, awayGoals: 0, odds: null }],
    "football-data",
    "2026-09-06T00:00:00Z",
  );
  assert.equal(n, 1);
  assert.equal(L.recordResults([{ division: "JAP", date: "2026-09-05T19:00:00Z", home: "Avispa Fukuoka", away: "Mito", homeGoals: 2, awayGoals: 0, odds: null }], "x", "t"), 0);
  assert.equal(L.settle("2026-09-06T00:10:00Z"), 1);
  assert.equal(L.settle("2026-09-06T00:20:00Z"), 0);
  const e = L.evaluations()[0];
  assert.equal(e.result, "H");
  assert.ok(Math.abs(e.rps - ((0.5 - 1) ** 2 + (0.75 - 1) ** 2) / 2) < 1e-9);
  assert.ok(e.marketRps !== null && e.marketRps > 0);
});

test("決済: キックオフ直前の市場でも RPS を測り、取得時刻を残す", () => {
  const L = fresh();
  const [f] = j1(); // Avispa Fukuoka v Mito, kickoff 2026-09-05 10:00Z
  L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  L.publishPrediction({
    providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, publishedAt: "2026-09-03T03:00:00Z", model: "dc-v2-ridge",
    asOf: "2026-09-03T01:00:00Z", nTrain: 1000, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.6, lambdaAway: 1.0,
    market: [0.4, 0.3, 0.3], marketFetchedAt: "2026-09-03T00:57:21Z",
  });
  L.recordResults(
    [{ division: "JAP", date: "2026-09-05T19:00:00Z", home: "Avispa Fukuoka", away: "Mito", homeGoals: 2, awayGoals: 0, odds: null }],
    "football-data", "2026-09-06T00:00:00Z",
  );
  // キックオフ直前（09-05 09:00Z）の市場はホーム 60%。試合後（11:00Z）のものは使ってはならない
  assert.equal(L.settle("2026-09-06T00:10:00Z", (providerId, kickoffAt) => {
    assert.equal(providerId, f.providerId);
    assert.equal(kickoffAt, f.kickoffAt);
    return { fetchedAt: "2026-09-05T09:00:00Z", market: [0.6, 0.22, 0.18] };
  }), 1);
  const e = L.evaluations()[0];
  assert.equal(e.marketClosingFetchedAt, "2026-09-05T09:00:00Z");
  // ホーム勝ちなので、ホームを高く見ていた直前の市場のほうが RPS は小さい
  assert.ok(e.marketRpsClosing !== null && e.marketRpsClosing! < e.marketRps!, `${e.marketRpsClosing} vs ${e.marketRps}`);
  // 発行時点の値は変わらない（台帳は追記専用・既存の意味を壊さない）
  assert.ok(Math.abs(e.marketRps! - ((0.4 - 1) ** 2 + (0.7 - 1) ** 2) / 2) < 1e-9);
});

test("決済: 直前の市場が無い試合は null で残す（推測で埋めない）", () => {
  const L = fresh();
  const [f] = j1();
  L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  L.publishPrediction({
    providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, publishedAt: "2026-09-03T03:00:00Z", model: "dc-v2-ridge",
    asOf: "2026-09-03T01:00:00Z", nTrain: 1000, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.6, lambdaAway: 1.0,
    market: [0.4, 0.3, 0.3], marketFetchedAt: "2026-09-03T00:57:21Z",
  });
  L.recordResults(
    [{ division: "JAP", date: "2026-09-05T19:00:00Z", home: "Avispa Fukuoka", away: "Mito", homeGoals: 2, awayGoals: 0, odds: null }],
    "football-data", "2026-09-06T00:00:00Z",
  );
  assert.equal(L.settle("2026-09-06T00:10:00Z", () => null), 1);
  const e = L.evaluations()[0];
  assert.equal(e.marketRpsClosing, null);
  assert.equal(e.marketClosingFetchedAt, null);
  assert.ok(e.marketRps !== null, "発行時点の対照は従来どおり残る");
});

test("決済: 解決子を渡さなければ従来どおり（既存の呼び出しを壊さない）", () => {
  const L = fresh();
  const [f] = j1();
  L.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  L.publishPrediction({
    providerId: f.providerId, league: "JAP", kickoffAt: f.kickoffAt, publishedAt: "2026-09-03T03:00:00Z", model: "dc-v1",
    asOf: "2026-09-03T01:00:00Z", nTrain: 1000, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.6, lambdaAway: 1.0,
    market: [0.4, 0.3, 0.3], marketFetchedAt: "2026-09-03T00:57:21Z",
  });
  L.recordResults(
    [{ division: "JAP", date: "2026-09-05T19:00:00Z", home: "Avispa Fukuoka", away: "Mito", homeGoals: 2, awayGoals: 0, odds: null }],
    "football-data", "2026-09-06T00:00:00Z",
  );
  assert.equal(L.settle("2026-09-06T00:10:00Z"), 1);
  assert.equal(L.evaluations()[0].marketRpsClosing, null);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 日程が動いた試合の決済（2026-09-25・本番台帳の実測から）
 *
 * 決済は「キックオフ日の ±1 日」でしか結んでいなかったため、延期・前倒しされた試合は
 * 結果が自分の履歴にあっても永久に決済されず、静かに記録から落ちていた。
 * ただし**窓を広げるだけでは 1 試合を 2 回数える**（同じカードの幽霊日程が実在した）。
 * この 3 件が本番で実際に詰まっていた形そのものである。
 * ──────────────────────────────────────────────────────────────────────────── */

const fixture = (providerId: string, kickoffAt: string, home: string, away: string): MarketFixture => ({
  provider: "football-data", providerId, sportKey: "test", kickoffAt, home, away,
  resolved: true, bookmakers: 0, market: null,
});

function withPrediction(L: Ledger, league: string, f: MarketFixture): void {
  L.recordFixtures([f], league, "2026-09-01T00:00:00Z");
  const r = L.publishPrediction({
    providerId: f.providerId, league, kickoffAt: f.kickoffAt, publishedAt: "2026-09-01T01:00:00Z",
    model: "dc-v5-shots", asOf: "2026-09-01T00:00:00Z", nTrain: 900,
    pHome: 0.4, pDraw: 0.3, pAway: 0.3, lambdaHome: 1.4, lambdaAway: 1.2, market: null, marketFetchedAt: null,
  });
  assert.ok(r.ok, `発行できていない: ${JSON.stringify(r)}`);
}

const resultRow = (league: string, date: string, home: string, away: string, hg: number, ag: number) => ({
  division: league, date, home, away, homeGoals: hg, awayGoals: ag, odds: null,
});

test("決済: 延期で日付が動いた試合も結ぶ（結果は台帳にあるのに落ちていた）", () => {
  const L = fresh();
  // 本番の実例: Utrecht v Go Ahead Eagles を 09-05 で予想 → 実際は 09-08 に 3-3
  withPrediction(L, "N1", fixture("utr-gae", "2026-09-05T16:45:00Z", "Utrecht", "Go Ahead Eagles"));
  L.recordResults([resultRow("N1", "2026-09-08", "Utrecht", "Go Ahead Eagles", 3, 3)], "football-data", "2026-09-11T00:00:00Z");
  assert.equal(L.settle("2026-09-11T00:10:00Z"), 1);
  const e = L.evaluations()[0]!;
  assert.equal(e.result, "D");
  assert.equal(e.homeGoals, 3);
  assert.equal(e.resultDate, "2026-09-08");
  assert.equal(e.matchedBy, "rescheduled");
  // 冪等
  assert.equal(L.settle("2026-09-11T00:20:00Z"), 0);
});

test("決済: ±1 日で結べた試合は従来どおり（matchedBy=kickoff）", () => {
  const L = fresh();
  withPrediction(L, "N1", fixture("a", "2026-09-05T16:45:00Z", "Utrecht", "Twente"));
  L.recordResults([resultRow("N1", "2026-09-05", "Utrecht", "Twente", 1, 0)], "football-data", "2026-09-08T00:00:00Z");
  assert.equal(L.settle("2026-09-08T00:10:00Z"), 1);
  assert.equal(L.evaluations()[0]!.matchedBy, "kickoff");
  assert.equal(L.evaluations()[0]!.resultDate, "2026-09-05");
});

test("決済: 同じカードの幽霊日程を 2 回数えない（本番の Sevilla v Valencia）", () => {
  const L = fresh();
  // 取得元が同じ試合を 09-11 と 09-13 の 2 つの日程として返していた。実際に行われたのは 1 試合
  withPrediction(L, "SP1", fixture("sev-val-11", "2026-09-11T19:00:00Z", "Sevilla", "Valencia"));
  withPrediction(L, "SP1", fixture("sev-val-13", "2026-09-13T19:00:00Z", "Sevilla", "Valencia"));
  L.recordResults([resultRow("SP1", "2026-09-11", "Sevilla", "Valencia", 1, 0)], "football-data", "2026-09-15T00:00:00Z");
  // 09-11 の予想だけが決済される。09-13 の幽霊は未決済のまま残す（フェイルクローズ）
  assert.equal(L.settle("2026-09-15T00:10:00Z"), 1);
  assert.equal(L.evaluations()[0]!.providerId, "sev-val-11");
  assert.equal(L.evaluations()[0]!.matchedBy, "kickoff");
  // 何度回しても増えない＝二重計上しない
  assert.equal(L.settle("2026-09-20T00:00:00Z"), 0);
  assert.equal(L.settle("2026-10-20T00:00:00Z"), 0);
});

test("決済: 結果が無い試合は決済しない（推測で埋めない）", () => {
  const L = fresh();
  // 本番の Levante v Ath Bilbao。9 月の結果がどこにも無い（中止か日程側の誤りか UNKNOWN）
  withPrediction(L, "SP1", fixture("lev-ath", "2026-09-16T19:30:00Z", "Levante", "Ath Bilbao"));
  L.recordResults([resultRow("SP1", "2026-09-13", "Levante", "Barcelona", 2, 4)], "football-data", "2026-09-18T00:00:00Z");
  assert.equal(L.settle("2026-10-20T00:00:00Z"), 0);
  assert.equal(L.evaluations().length, 0);
});

test("決済: 窓の外の結果は結ばない（別の対戦に食い付かせない）", () => {
  const L = fresh();
  withPrediction(L, "SC0", fixture("cel-ran", "2026-09-05T14:00:00Z", "Celtic", "Rangers"));
  // 同じ並びの対戦がシーズン内でもう一度ある（SC0 は同一カードを 3〜4 回やる）
  L.recordResults([resultRow("SC0", "2026-12-20", "Celtic", "Rangers", 2, 1)], "football-data", "2026-12-22T00:00:00Z");
  assert.equal(L.settle("2026-12-22T00:10:00Z"), 0);
  assert.equal(L.evaluations().length, 0);
});
