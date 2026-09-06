/**
 * Settlement rules are versioned objects and a re-evaluation under another
 * rule is appended beside the original, never in its place (judgment 1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CALIBRATION } from "../src/engine/decision";
import { settle } from "../src/engine/settle";
import {
  newRecords,
  reevaluateDate,
  summarizeReevaluations,
  type RegulationScoreFile,
} from "../src/engine/reevaluate";
import { productionRule, ruleById, ruleTag, SETTLEMENT_RULES } from "../src/engine/settlement-rules";
import { DEMO_GAME_PK, demoPrediction } from "./fixture-prediction";

const NOW = new Date("2026-09-06T00:00:00Z");

test("every rule carries id, version, basis, PUSH-on-tie and a league; production rules are the ledger's basis", () => {
  for (const r of Object.values(SETTLEMENT_RULES)) {
    assert.match(ruleTag(r), /^[A-Z0-9_]+\/v\d+$/);
    assert.equal(r.tie, "PUSH");
    assert.ok(r.basis.length > 10);
    assert.ok(r.notes.length >= 1);
  }
  assert.equal(productionRule("mlb").id, "MLB_FINAL_SCORE");
  // NPB production is the posted final — the policy's regulation-9 basis is a
  // re-evaluation rule until it is promoted by an explicit, reviewed change.
  assert.equal(productionRule("npb").id, "NPB_FINAL_POSTED_SCORE");
  assert.equal(ruleById("NPB_REGULATION_9").status, "reevaluation");
  assert.throws(() => ruleById("NPB_SOMETHING_ELSE"));
});

function regulation(games: RegulationScoreFile["games"]): RegulationScoreFile {
  return {
    date: "2024-07-25",
    rule: "NPB_REGULATION_9/v1",
    importedAt: "2026-09-06T00:00:00Z",
    provenance: { kind: "test", commit: "0000000", note: "unit test" },
    games,
  };
}

test("re-evaluation keeps the original, scores the regulation score, and flags what changed", async () => {
  const pred = await demoPrediction();
  const pk = String(DEMO_GAME_PK);
  // Original (posted final): home lost 2-6 in extras → winner pick (home) wrong.
  const original = settle("2024-07-25", [pred], { [pk]: { homeScore: 2, awayScore: 6 } }, DEFAULT_CALIBRATION, NOW);
  // Regulation: level 2-2 after nine → PUSH under the 9-inning rule.
  const reg = regulation({
    [pk]: { homeScore: 2, awayScore: 2, regulationInnings: 9, inningsPlayed: 9, source: "npb.jp score page", url: "https://npb.jp/scores/x/", observedAt: "2026-08-11T00:00:00Z" },
  });
  const out = reevaluateDate({
    league: "npb", date: "2024-07-25", predictions: [pred], calibration: DEFAULT_CALIBRATION, regulation: reg,
    original, rule: ruleById("NPB_REGULATION_9"), originalRule: productionRule("npb"), codeVersion: "abc", now: NOW, reason: "test",
  });
  assert.equal(out.unevaluated.length, 0);
  assert.equal(out.records.length, 1);
  const r = out.records[0]!;
  assert.deepEqual(r.rule, { id: "NPB_REGULATION_9", version: 1 });
  assert.deepEqual(r.originalRule, { id: "NPB_FINAL_POSTED_SCORE", version: 1 });
  assert.equal(r.original!.winnerCorrect, false); // untouched original
  assert.equal(r.reevaluated.winnerCorrect, null); // PUSH
  assert.equal(r.reevaluated.actualWinner, null);
  assert.equal(r.changed.winner, true);
  assert.equal(r.resultData.url, "https://npb.jp/scores/x/");
  assert.equal(r.evaluatorCodeVersion, "abc");
  assert.match(r.predictionId, /^npb:2024-07-25:745804$/);
  // Idempotent: the same record is not appended twice; a new observation is.
  assert.equal(newRecords(out.records, out.records).length, 0);
  const again = reevaluateDate({ ...{
    league: "npb" as const, date: "2024-07-25", predictions: [pred], calibration: DEFAULT_CALIBRATION,
    regulation: regulation({ [pk]: { ...reg.games[pk]!, observedAt: "2026-08-12T00:00:00Z" } }),
    original, rule: ruleById("NPB_REGULATION_9"), originalRule: productionRule("npb"), codeVersion: "abc", now: NOW, reason: "test",
  } });
  assert.equal(newRecords(out.records, again.records).length, 1);
  const s = summarizeReevaluations(out.records);
  assert.equal(s.changedWinner, 1);
  assert.equal(s.changedHandicap, 0);
});

test("a game without a regulation score is unevaluated — never filled from the posted final", async () => {
  const pred = await demoPrediction();
  const out = reevaluateDate({
    league: "npb", date: "2024-07-25", predictions: [pred], calibration: DEFAULT_CALIBRATION, regulation: regulation({}),
    original: null, rule: ruleById("NPB_REGULATION_9"), originalRule: productionRule("npb"), codeVersion: "abc", now: NOW, reason: "test",
  });
  assert.equal(out.records.length, 0);
  assert.equal(out.unevaluated.length, 1);
  assert.match(out.unevaluated[0]!.reason, /no regulation score/);
  const none = reevaluateDate({
    league: "npb", date: "2024-07-25", predictions: [pred], calibration: DEFAULT_CALIBRATION, regulation: null,
    original: null, rule: ruleById("NPB_REGULATION_9"), originalRule: productionRule("npb"), codeVersion: "abc", now: NOW, reason: "test",
  });
  assert.match(none.unevaluated[0]!.reason, /no regulation-score file/);
});
