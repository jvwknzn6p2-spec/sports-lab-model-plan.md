/**
 * サッカーの決済不変条件（.ai/ASTRA_REVIEW_POLICY.md §2）を実行可能な仕様として固定する:
 *   - 得点は 90 分＋アディショナルタイム（football-data.co.uk の FTHG/FTAG）。
 *     前半（HTHG）でも延長・PK でもない
 *   - 引き分けは結果の 1 つ。分母に入り、決済される（野球の PUSH とは違う）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFootballDataRaw } from "../src/footballDataRaw.ts";
import { Ledger } from "../src/ledger.ts";
import { outcomeOf } from "../src/scoring.ts";

const CSV = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,B365H,B365D,B365A",
  // Half-time 2-0, full-time 2-2 — settlement must read the FULL-TIME columns.
  "E0,05/09/2026,15:00,Arsenal,Chelsea,2,2,D,2,0,H,1.9,3.6,4.0",
  "E0,05/09/2026,17:30,Leeds,Everton,1,0,H,0,0,D,2.4,3.3,3.0",
].join("\n");

test("結果は FTHG/FTAG（90 分＋アディショナルタイム）で、HTHG ではない", () => {
  const { matches } = parseFootballDataRaw(CSV);
  assert.equal(matches.length, 2);
  assert.deepEqual([matches[0]!.homeGoals, matches[0]!.awayGoals], [2, 2]);
  assert.deepEqual([matches[1]!.homeGoals, matches[1]!.awayGoals], [1, 0]);
});

test("引き分けは outcome 1 として決済され、分母に残る", () => {
  assert.equal(outcomeOf(2, 2), 1);
  const L = new Ledger(mkdtempSync(join(tmpdir(), "settle-")));
  const fixtures = [
    { provider: "the-odds-api" as const, sportKey: "soccer_epl", resolved: true, bookmakers: 0, market: null, providerId: "m1", kickoffAt: "2026-09-05T14:00:00Z", home: "Arsenal", away: "Chelsea" },
    { provider: "the-odds-api" as const, sportKey: "soccer_epl", resolved: true, bookmakers: 0, market: null, providerId: "m2", kickoffAt: "2026-09-05T16:30:00Z", home: "Leeds", away: "Everton" },
  ];
  assert.equal(L.recordFixtures(fixtures, "E0", "2026-09-03T01:00:00Z").added, 2);
  for (const [id, pHome, pDraw, pAway] of [["m1", 0.5, 0.25, 0.25], ["m2", 0.4, 0.3, 0.3]] as const) {
    const r = L.publishPrediction({
      providerId: id, league: "E0", kickoffAt: fixtures.find((f) => f.providerId === id)!.kickoffAt,
      publishedAt: "2026-09-04T03:10:00.000Z", model: "dc-v1", asOf: "2026-09-04T03:10:00.000Z",
      nTrain: 1000, pHome, pDraw, pAway, lambdaHome: 1.5, lambdaAway: 1.2, market: null, marketFetchedAt: null,
    });
    assert.ok(r.ok, JSON.stringify(r));
  }
  L.recordResults(parseFootballDataRaw(CSV).matches, "football-data.co.uk", "2026-09-06T03:05:00Z");
  assert.equal(L.settle("2026-09-06T03:05:00Z"), 2);
  const ev = L.evaluations();
  const draw = ev.find((e) => e.providerId === "m1")!;
  assert.equal(draw.result, "D");
  assert.deepEqual([draw.homeGoals, draw.awayGoals], [2, 2]);
  assert.ok(draw.rps > 0 && draw.rps < 1);
  assert.equal(ev.find((e) => e.providerId === "m2")!.result, "H");
});

test("封緘（キックオフ 60 分前）以後の発行は台帳が拒否する", () => {
  const L = new Ledger(mkdtempSync(join(tmpdir(), "seal-")));
  L.recordFixtures(
    [{ provider: "the-odds-api", sportKey: "soccer_epl", resolved: true, bookmakers: 0, market: null, providerId: "m1", kickoffAt: "2026-09-05T14:00:00Z", home: "Arsenal", away: "Chelsea" }],
    "E0",
    "2026-09-03T01:00:00Z",
  );
  const r = L.publishPrediction({
    providerId: "m1", league: "E0", kickoffAt: "2026-09-05T14:00:00Z",
    publishedAt: "2026-09-05T13:00:00.000Z", model: "dc-v1", asOf: "2026-09-05T13:00:00.000Z",
    nTrain: 1000, pHome: 0.5, pDraw: 0.25, pAway: 0.25, lambdaHome: 1.5, lambdaAway: 1.2, market: null, marketFetchedAt: null,
  });
  assert.equal(r.ok, false);
});
