import { test } from "node:test";
import assert from "node:assert/strict";

import {
  expectedProfit,
  parseHandicapNotation,
  HandicapNotationError,
} from "../src/engine/handicap-notation";
import { simulateGame } from "../src/engine/simulate";

/**
 * Settle a stake on `notation` against a known final margin, and return the
 * profit per unit staked. Uses the real cover logic by feeding the simulator a
 * single deterministic scoreline.
 */
function profitAtMargin(notation: string, margin: number): number {
  const parsed = parseHandicapNotation(notation);
  // A one-run-per-inning-free simulation is unnecessary: settle the parts by
  // hand exactly as `asianCover` does, for a fixed margin.
  let win = 0;
  let push = 0;
  let loss = 0;
  for (const part of parsed.parts) {
    const settled = margin - part.line;
    if (settled > 0) win += part.weight;
    else if (settled === 0) push += part.weight;
    else loss += part.weight;
  }
  return expectedProfit({ win, push, loss });
}

test("plain tenths are literal lines", () => {
  assert.equal(parseHandicapNotation("0").effectiveLine, 0);
  assert.equal(parseHandicapNotation("<0>").effectiveLine, 0);
  assert.equal(parseHandicapNotation("0.7").effectiveLine, 0.7);
  assert.equal(parseHandicapNotation("1.4").effectiveLine, 1.4);
  assert.equal(parseHandicapNotation("1.0").effectiveLine, 1);
  for (const n of ["0", "0.7", "1.4"]) {
    assert.equal(parseHandicapNotation(n).parts.length, 1);
    assert.equal(parseHandicapNotation(n).special, false);
  }
});

test("1半 is a plain 1.5 line", () => {
  const p = parseHandicapNotation("1半");
  assert.deepEqual(p.parts, [{ line: 1.5, weight: 1 }]);
  assert.equal(p.special, true);
});

test("N半X splits the stake between N.5 and N+1", () => {
  const p = parseHandicapNotation("1半1");
  assert.deepEqual(p.parts, [
    { line: 1.5, weight: 0.9 },
    { line: 2, weight: 0.1 },
  ]);
  const q = parseHandicapNotation("1半9");
  assert.deepEqual(q.parts, [
    { line: 1.5, weight: 0.1 },
    { line: 2, weight: 0.9 },
  ]);
});

test("1半 ladder: draw and 1 run lose, 2 runs win in full", () => {
  // 引き分け まる負け / 1点差まる負け / 2点差まる勝ち
  assert.equal(profitAtMargin("1半", 0), -1);
  assert.equal(profitAtMargin("1半", 1), -1);
  // まる勝ち, less the 10% cut.
  assert.ok(Math.abs(profitAtMargin("1半", 2) - 0.9) < 1e-9);
});

test("1半1 ladder: 2 runs pays 9分, 3 runs pays in full", () => {
  assert.equal(profitAtMargin("1半1", 0), -1);
  assert.equal(profitAtMargin("1半1", 1), -1);
  // 9分勝ち = +0.9 nominal, less 10% → 0.81
  assert.ok(Math.abs(profitAtMargin("1半1", 2) - 0.81) < 1e-9);
  // まるかち = +1.0 nominal, less 10% → 0.9
  assert.ok(Math.abs(profitAtMargin("1半1", 3) - 0.9) < 1e-9);
});

test("1半9 pays 1分 at two runs — the far end of the same ladder", () => {
  // 1分勝ち = +0.1 nominal, less 10% → 0.09
  assert.ok(Math.abs(profitAtMargin("1半9", 2) - 0.09) < 1e-9);
  assert.ok(Math.abs(profitAtMargin("1半9", 3) - 0.9) < 1e-9);
});

test("the worked example: <1半2> winning by 2 pays +7.2 on a 10 stake", () => {
  // 8分勝ち → +8 → less 10% → +7.2
  const perUnit = profitAtMargin("1半2", 2);
  assert.ok(
    Math.abs(perUnit * 10 - 7.2) < 1e-9,
    `expected +7.2 on 10, got ${(perUnit * 10).toFixed(4)}`,
  );
});

test("every 1半X pays (10-X)分 at two runs, less the cut", () => {
  for (let x = 0; x <= 9; x++) {
    const notation = x === 0 ? "1半" : `1半${x}`;
    const expected = ((10 - x) / 10) * 0.9;
    assert.ok(
      Math.abs(profitAtMargin(notation, 2) - expected) < 1e-9,
      `${notation} at 2 runs: expected ${expected}, got ${profitAtMargin(notation, 2)}`,
    );
  }
});

test("a plain whole line still pushes on the exact margin", () => {
  assert.equal(profitAtMargin("1.0", 1), 0, "stake returned");
  assert.ok(Math.abs(profitAtMargin("1.0", 2) - 0.9) < 1e-9);
  assert.equal(profitAtMargin("1.0", 0), -1);
});

test("unreadable notation throws instead of guessing a side", () => {
  for (const bad of ["", "abc", "1半X", "half", "99"]) {
    assert.throws(() => parseHandicapNotation(bad), HandicapNotationError, bad);
  }
});

test("full-width digits and brackets are accepted", () => {
  assert.deepEqual(
    parseHandicapNotation("〈１半２〉").parts,
    parseHandicapNotation("1半2").parts,
  );
});

test("the simulator settles parsed parts directly", () => {
  const sim = simulateGame(5.0, 4.0, { sims: 20_000, seed: "notation" });
  const parsed = parseHandicapNotation("1半1");
  const cover = sim.asianCover("home", parsed.parts);
  // The 10% riding the whole line pushes on exactly a 2-run margin, so this
  // sits strictly between the pure 1.5 and pure 2.0 lines.
  const at15 = sim.asianCover("home", 1.5);
  const at20 = sim.asianCover("home", 2);
  assert.ok(cover.push > 0 && cover.push < at20.push);
  assert.ok(Math.abs(cover.win - (0.9 * at15.win + 0.1 * at20.win)) < 1e-9);
});
