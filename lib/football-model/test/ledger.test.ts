import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, cutoffOf } from "../src/ledger.ts";
import { parseOddsEvents, type OddsEvent } from "../src/oddsApi.ts";
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

test("cutoffOf: キックオフ 60 分前", () => {
  assert.equal(cutoffOf("2026-09-05T10:00:00Z"), "2026-09-05T09:00:00.000Z");
});

test("日程: 解決済みだけ登録し、同じ内容は追記しない・キックオフ変更は行が増える", () => {
  const L = fresh();
  const fx1 = j1();
  assert.deepEqual(L.recordFixtures(fx1, "JAP", "2026-09-03T01:00:00Z"), { added: 10, unresolved: 0 });
  assert.deepEqual(L.recordFixtures(fx1, "JAP", "2026-09-03T02:00:00Z"), { added: 0, unresolved: 0 });
  const moved = [{ ...fx1[0], kickoffAt: "2026-09-05T11:00:00Z" }];
  assert.equal(L.recordFixtures(moved, "JAP", "2026-09-03T03:00:00Z").added, 1);
  assert.equal(L.currentMatches().get(fx1[0].providerId)!.kickoffAt, "2026-09-05T11:00:00Z");
  assert.equal(L.matches().length, 11);
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
  assert.equal(r1.row.cutoffAt, "2026-09-05T09:00:00.000Z");
  assert.match(r1.row.fingerprint, /^[0-9a-f]{64}$/);
  const dup = L.publishPrediction({ ...base, publishedAt: "2026-09-03T04:00:00Z" });
  assert.deepEqual(dup, { ok: false, reason: "already published" });
  const L2 = fresh();
  L2.recordFixtures([f], "JAP", "2026-09-03T01:00:00Z");
  assert.equal((L2.publishPrediction({ ...base, publishedAt: "2026-09-05T09:00:00.000Z" }) as { reason: string }).reason.slice(0, 6), "sealed");
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
