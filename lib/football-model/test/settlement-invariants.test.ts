/**
 * サッカーの決済不変条件（.ai/ASTRA_REVIEW_POLICY.md §2）を実行可能な仕様として固定する:
 *   - 得点は 90 分＋アディショナルタイム（football-data.co.uk の FTHG/FTAG）。
 *     前半（HTHG）でも延長・PK でもない
 *   - 引き分けは結果の 1 つ。分母に入り、決済される（野球の PUSH とは違う）
 * 封緘後の発行拒否は ledger.test.ts が既に固定している。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFootballDataRaw } from "../src/footballDataRaw.ts";
import { fresh } from "./helpers.ts";

const CSV = [
  "Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,B365H,B365D,B365A",
  // 前半 2-0・終了時 2-2 — 決済は FULL-TIME の列を読まなければならない
  "E0,05/09/2026,15:00,Arsenal,Chelsea,2,2,D,2,0,H,1.9,3.6,4.0",
  "E0,05/09/2026,17:30,Leeds,Everton,1,0,H,0,0,D,2.4,3.3,3.0",
].join("\n");

const FIXTURE = { provider: "the-odds-api" as const, sportKey: "soccer_epl", resolved: true, bookmakers: 0, market: null };
const ISSUED = { publishedAt: "2026-09-04T03:10:00.000Z", model: "dc-v1", asOf: "2026-09-04T03:10:00.000Z", nTrain: 1000, lambdaHome: 1.5, lambdaAway: 1.2, market: null, marketFetchedAt: null };

test("結果は FTHG/FTAG（90 分＋アディショナルタイム）で、HTHG ではない", () => {
  const { matches } = parseFootballDataRaw(CSV);
  assert.deepEqual(matches.map((m) => [m.homeGoals, m.awayGoals]), [[2, 2], [1, 0]]);
});

test("引き分けは D として決済され、分母に残る", () => {
  const L = fresh();
  L.recordFixtures(
    [
      { ...FIXTURE, providerId: "m1", kickoffAt: "2026-09-05T14:00:00Z", home: "Arsenal", away: "Chelsea" },
      { ...FIXTURE, providerId: "m2", kickoffAt: "2026-09-05T16:30:00Z", home: "Leeds", away: "Everton" },
    ],
    "E0",
    "2026-09-03T01:00:00Z",
  );
  assert.ok(L.publishPrediction({ ...ISSUED, providerId: "m1", league: "E0", kickoffAt: "2026-09-05T14:00:00Z", pHome: 0.5, pDraw: 0.25, pAway: 0.25 }).ok);
  assert.ok(L.publishPrediction({ ...ISSUED, providerId: "m2", league: "E0", kickoffAt: "2026-09-05T16:30:00Z", pHome: 0.4, pDraw: 0.3, pAway: 0.3 }).ok);
  L.recordResults(parseFootballDataRaw(CSV).matches, "football-data.co.uk", "2026-09-06T03:05:00Z");
  assert.equal(L.settle("2026-09-06T03:05:00Z"), 2);
  const byId = new Map(L.evaluations().map((e) => [e.providerId, e]));
  const draw = byId.get("m1")!;
  assert.equal(draw.result, "D");
  assert.deepEqual([draw.homeGoals, draw.awayGoals], [2, 2]);
  assert.ok(draw.rps > 0 && draw.rps < 1);
  assert.equal(byId.get("m2")!.result, "H");
});
