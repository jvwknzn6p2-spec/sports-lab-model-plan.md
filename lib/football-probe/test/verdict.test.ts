import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCapture, combineEvidence } from "../src/verdict";
import { assessRun } from "../src/assess";
import { smIncludeCount, smListCount, oddsApiSportListed } from "../src/extract";
import type { Capture, CaptureMeta } from "../src/types";
import { PHASE0_ITEMS } from "../src/types";

function cap(status: number | "ERR", body: string, name = "x.json"): Capture {
  const meta: CaptureMeta = {
    provider: "test",
    name,
    endpoint: "/x",
    url: "https://x.test/x",
    method: "GET",
    requestedAt: "2026-08-30T00:00:00.000Z",
    respondedAt: "2026-08-30T00:00:01.000Z",
    status,
    bytes: body.length,
    sha256: "0".repeat(64),
  };
  return { meta, body };
}

test("2xx with data -> AVAILABLE", () => {
  const r = classifyCapture(cap(200, '{"data":[{"id":1}]}'), smListCount);
  assert.equal(r.verdict, "AVAILABLE");
});

test("2xx with empty list -> PARTIAL", () => {
  const r = classifyCapture(cap(200, '{"data":[]}'), smListCount);
  assert.equal(r.verdict, "PARTIAL");
});

test("2xx without the expected shape -> PARTIAL (shape not found)", () => {
  const r = classifyCapture(cap(200, '{"message":"ok"}'), smListCount);
  assert.equal(r.verdict, "PARTIAL");
  assert.match(r.detail, /shape not found/);
});

test("403 -> UNAVAILABLE (plan denial is a real answer)", () => {
  assert.equal(classifyCapture(cap(403, '{"message":"no"}'), smListCount).verdict, "UNAVAILABLE");
  assert.equal(classifyCapture(cap(404, ""), smListCount).verdict, "UNAVAILABLE");
});

test("401 carrying an *_UNAVAILABLE_* error_code -> UNAVAILABLE (plan denial)", () => {
  // Exact shape captured 2026-08-30 from The Odds API historical endpoint.
  const body =
    '{"message":"Historical odds are only available on paid usage plans.",' +
    '"error_code":"HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN"}';
  const r = classifyCapture(cap(401, body), smListCount);
  assert.equal(r.verdict, "UNAVAILABLE");
  assert.match(r.detail, /HISTORICAL_UNAVAILABLE_ON_FREE_USAGE_PLAN/);
});

test("401 and transport failure -> UNVERIFIED (proves nothing about the data)", () => {
  assert.equal(classifyCapture(cap(401, ""), smListCount).verdict, "UNVERIFIED");
  assert.equal(classifyCapture(cap("ERR", ""), smListCount).verdict, "UNVERIFIED");
  assert.equal(classifyCapture(cap(500, ""), smListCount).verdict, "UNVERIFIED");
  assert.equal(classifyCapture(cap(200, "<html>"), smListCount).verdict, "UNVERIFIED");
});

test("include extractor counts nested include payloads", () => {
  const body = '{"data":{"id":9,"lineups":[{"a":1},{"a":2}]}}';
  assert.equal(classifyCapture(cap(200, body), smIncludeCount(["lineups"])).verdict, "AVAILABLE");
  const empty = '{"data":{"id":9,"lineups":[]}}';
  assert.equal(classifyCapture(cap(200, empty), smIncludeCount(["lineups"])).verdict, "PARTIAL");
  const absent = '{"data":{"id":9}}';
  assert.equal(classifyCapture(cap(200, absent), smIncludeCount(["lineups"])).verdict, "PARTIAL");
});

test("odds sports catalog extractor finds the Eredivisie key", () => {
  const body = '[{"key":"soccer_epl"},{"key":"soccer_netherlands_eredivisie","active":true}]';
  const r = classifyCapture(cap(200, body), oddsApiSportListed("soccer_netherlands_eredivisie"));
  assert.equal(r.verdict, "AVAILABLE");
});

test("combineEvidence: strongest verdict wins, all evidence retained", () => {
  const denied = classifyCapture(cap(403, "", "sm.json"), smListCount);
  const ok = classifyCapture(cap(200, '{"data":[{}]}', "oa.json"), smListCount);
  const v = combineEvidence("odds", [denied, ok], "n/a");
  assert.equal(v.verdict, "AVAILABLE");
  assert.deepEqual(v.evidence, ["sm.json", "oa.json"]);
  assert.match(v.reason, /UNAVAILABLE/);
  assert.match(v.reason, /AVAILABLE/);
});

test("assessRun with zero captures: all 12 items UNVERIFIED, in brief order", () => {
  const verdicts = assessRun(new Map(), "not attempted (credential not configured)");
  assert.equal(verdicts.length, 12);
  assert.deepEqual(
    verdicts.map((v) => v.item),
    [...PHASE0_ITEMS],
  );
  for (const v of verdicts) {
    assert.equal(v.verdict, "UNVERIFIED");
    assert.match(v.reason, /not attempted/);
  }
});
