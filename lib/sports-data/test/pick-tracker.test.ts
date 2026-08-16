import { test } from "node:test";
import assert from "node:assert/strict";

import { pickTrackerBlock } from "../src/cli/pick-tracker";
import type { GamePrediction } from "../src/engine/decision";

/**
 * The consumer of this block is a separate app (Pick Tracker Pro) whose parser
 * we do not control and cannot import. To keep this contract honest, the rules
 * below are transcribed from that parser (`src/lib/tracker/parser.ts`) and the
 * generated text is run through them — so a change on either side that breaks
 * the paste shows up here rather than silently producing an unlogged slate.
 */

function splitBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*(\d+|[０-９]+)[.．)]\s*/.test(line)) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

function pickAfter(text: string, key: string): string {
  const m = text.match(new RegExp(`${key}\\s*[：:]\\s*(.+?)\\s*$`, "m"));
  return m ? m[1]!.trim() : "";
}

function detectDate(text: string): string {
  const m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
}

/** Reproduces the consumer's accept/reject decision for one block. */
function parseBlock(block: string) {
  if (!/(ハンデ|予想|勝率)[：:]/.test(block)) return null; // skipped outright
  const firstLine = block.split(/\r?\n/)[0] ?? "";
  const match = firstLine.replace(/^\s*(\d+|[０-９]+)[.．)]\s*/, "").trim();
  const pick = pickAfter(block, "予想");
  if (!match || !pick) return null; // reported as unparsed
  const probStr = pickAfter(block, "勝率");
  return {
    match,
    pick,
    handicap: pickAfter(block, "ハンデ"),
    winProb: parseFloat(probStr.replace(/[^\d.]/g, "")),
  };
}

/** Their fine-rank thresholds, to confirm the engine's band is reproduced. */
function fineRankFromProb(p: number): string {
  if (p >= 68) return "S+";
  if (p >= 66) return "S";
  if (p >= 65) return "S-";
  if (p >= 63) return "A+";
  if (p >= 61) return "A";
  if (p >= 60) return "A-";
  if (p >= 58) return "B+";
  if (p >= 56) return "B";
  if (p >= 55) return "B-";
  if (p >= 53) return "C+";
  if (p >= 51) return "C";
  if (p >= 50) return "C-";
  return "";
}

function prediction(over: Partial<GamePrediction> = {}): GamePrediction {
  return {
    gamePk: 1,
    gameDate: null,
    home: "Cleveland Guardians",
    away: "Detroit Tigers",
    pass: false,
    predictedWinner: "Cleveland Guardians",
    predictedLoser: "Detroit Tigers",
    winProbability: 0.612,
    rawWinProbability: 0.63,
    confidence: "A",
    handicap: {
      input: { side: "home", line: -1.5 },
      pick: "Cleveland Guardians -1.5",
      coverProbability: 0.55,
      rawCoverProbability: 0.56,
      ev: null,
      noValue: false,
    },
    total: {
      line: 8.5,
      predicted: 7.9,
      pick: "UNDER",
      probability: 0.58,
      rawProbability: 0.59,
    },
    expectedRuns: { home: 4.6, away: 4.1 },
    reasons: ["Starter edge: Cleveland Guardians"],
    flags: [],
    ...over,
  };
}

test("generated block survives the consumer's parser", () => {
  const text = pickTrackerBlock("2024-07-25", [
    prediction(),
    prediction({
      gamePk: 2,
      home: "Atlanta Braves",
      away: "Philadelphia Phillies",
      predictedWinner: "Atlanta Braves",
      predictedLoser: "Philadelphia Phillies",
      winProbability: 0.664,
    }),
  ])!;

  assert.equal(detectDate(text), "2024-07-25");
  assert.ok(
    text.split(/\r?\n/).slice(0, 3).join(" ").includes("MLB"),
    "sport keyword in header",
  );

  const parsed = splitBlocks(text).map(parseBlock).filter(Boolean);
  assert.equal(parsed.length, 2, "both games parse");

  // Neither game has a quoted line here, so rankByValue falls through EV to
  // confidence and then win probability: the 66.4% game leads the 61.2% one.
  assert.equal(parsed[0]!.match, "Philadelphia Phillies vs Atlanta Braves");
  assert.equal(parsed[1]!.match, "Detroit Tigers vs Cleveland Guardians");
  assert.equal(parsed[1]!.pick, "Cleveland Guardians");
  assert.equal(parsed[1]!.handicap, "Cleveland Guardians -1.5");
  assert.ok(Math.abs(parsed[1]!.winProb - 61.2) < 0.001);

  // The rank the consumer derives must agree with the engine's own band.
  assert.equal(fineRankFromProb(parsed[1]!.winProb)[0], "A");
  assert.equal(fineRankFromProb(parsed[0]!.winProb)[0], "S");
});

test("PASS games are excluded so they cannot dilute the hit rate", () => {
  const text = pickTrackerBlock("2024-07-25", [
    prediction(),
    prediction({
      gamePk: 2,
      pass: true,
      predictedWinner: null,
      predictedLoser: null,
    }),
  ])!;
  const parsed = splitBlocks(text).map(parseBlock).filter(Boolean);
  assert.equal(parsed.length, 1);
});

test("an all-PASS day produces no block at all", () => {
  const text = pickTrackerBlock("2024-07-25", [
    prediction({ pass: true, predictedWinner: null, predictedLoser: null }),
  ]);
  assert.equal(text, null);
});

test("a game with no handicap line still fills the field", () => {
  const text = pickTrackerBlock("2024-07-25", [
    prediction({
      handicap: {
        input: null,
        pick: null,
        coverProbability: null,
        rawCoverProbability: null,
        ev: null,
        noValue: false,
      },
      total: {
        line: null,
        predicted: 8,
        pick: null,
        probability: null,
        rawProbability: null,
      },
    }),
  ])!;
  const parsed = splitBlocks(text).map(parseBlock).filter(Boolean);
  assert.equal(parsed.length, 1);
  assert.notEqual(
    parsed[0]!.handicap,
    "",
    "handicap field must never be blank",
  );
});
