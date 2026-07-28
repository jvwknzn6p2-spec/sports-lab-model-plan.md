import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBattingMetrics,
  obp,
  slg,
  woba,
  type RawBattingLine,
} from "../src/sabermetrics/batting";
import { getLeagueConstants } from "../src/sabermetrics/constants";

const LINE: RawBattingLine = {
  plateAppearances: 6015,
  atBats: 5400,
  hits: 1400,
  doubles: 280,
  triples: 25,
  homeRuns: 200,
  baseOnBalls: 520,
  intentionalWalks: 30,
  hitByPitch: 55,
  sacFlies: 40,
  strikeOuts: 1300,
};

const C2023 = getLeagueConstants(2023);

test("wOBA weights events by run value", () => {
  // hand-computed against 2023 weights → 0.3274
  const value = woba(LINE, C2023)!;
  assert.ok(Math.abs(value - 0.3274) < 0.001, `wOBA=${value}`);
});

test("OBP and SLG", () => {
  assert.ok(Math.abs(obp(LINE)! - 0.3284) < 0.001);
  assert.ok(Math.abs(slg(LINE)! - 0.4315) < 0.001);
});

test("computeBattingMetrics: full set", () => {
  const m = computeBattingMetrics(LINE, 2023);
  assert.equal(m.season, 2023);
  assert.equal(m.woba, 0.327);
  assert.equal(m.obp, 0.328);
  assert.equal(m.slg, 0.431);
  assert.equal(m.avg, 0.259);
  assert.equal(m.iso, 0.172);
  // Above-average offense → wRC+ over 100.
  assert.ok(
    m.wrcPlus !== null && m.wrcPlus >= 104 && m.wrcPlus <= 109,
    `wRC+=${m.wrcPlus}`,
  );
});

test("league-average offense produces wRC+ ≈ 100", () => {
  // Construct a line whose wOBA equals league wOBA by using only walks priced
  // at exactly the average is hard; instead verify a neutral-ish line lands near 100.
  const avgLine: RawBattingLine = {
    plateAppearances: 6000,
    atBats: 5350,
    hits: 1330,
    doubles: 250,
    triples: 25,
    homeRuns: 170,
    baseOnBalls: 480,
    intentionalWalks: 25,
    hitByPitch: 55,
    sacFlies: 40,
    strikeOuts: 1350,
  };
  const m = computeBattingMetrics(avgLine, 2023);
  assert.ok(
    m.wrcPlus !== null && Math.abs(m.wrcPlus - 100) <= 12,
    `wRC+=${m.wrcPlus}`,
  );
});
