import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePitchingMetrics,
  fip,
  fipMinus,
  xfip,
  type RawPitchingLine,
} from "../src/sabermetrics/pitching";
import { getLeagueConstants } from "../src/sabermetrics/constants";

// Deterministic line: HR=15, BB=45, HBP=5, K=200, IP=180.0.
const LINE: RawPitchingLine = {
  inningsPitched: "180.0",
  battersFaced: 720,
  strikeOuts: 200,
  baseOnBalls: 45,
  hitByPitch: 5,
  homeRuns: 15,
  hits: 150,
  earnedRuns: 60,
  runs: 66,
  atBats: 660,
  sacFlies: 5,
  flyBalls: 200,
};

const C2023 = getLeagueConstants(2023); // cFIP 3.257, lgFIP 4.33, hrPerFB .126

test("FIP formula on the ERA scale", () => {
  // (13*15 + 3*50 - 2*200)/180 + 3.257 = -0.3056 + 3.257 = 2.951
  const value = fip(LINE, C2023)!;
  assert.ok(Math.abs(value - 2.951) < 0.002, `FIP=${value}`);
});

test("xFIP normalizes HR to league fly-ball rate", () => {
  // expHR = 200*0.126 = 25.2; (13*25.2 + 150 - 400)/180 + 3.257 = 3.688
  const { value, estimated } = xfip(LINE, C2023);
  assert.equal(estimated, false);
  assert.ok(Math.abs(value! - 3.688) < 0.003, `xFIP=${value}`);
});

test("xFIP flags estimation when batted-ball data is absent", () => {
  const noFB: RawPitchingLine = { ...LINE, flyBalls: undefined };
  const { estimated } = xfip(noFB, C2023);
  assert.equal(estimated, true);
});

test("FIP- indexes to league (100 = average, lower better)", () => {
  const fv = fip(LINE, C2023);
  const minus = fipMinus(fv, C2023)!;
  // 100 * 2.951 / 4.33 = 68.2
  assert.ok(Math.abs(minus - 68.2) < 0.6, `FIP-=${minus}`);
});

test("computePitchingMetrics: full FIP-forward set", () => {
  const m = computePitchingMetrics(LINE, 2023);
  assert.equal(m.season, 2023);
  assert.equal(m.fip, 2.95);
  assert.equal(m.xfip, 3.69);
  assert.equal(m.fipMinus, 68);
  assert.equal(m.era, 3.0);
  assert.equal(m.whip, 1.08);
  assert.equal(m.k9, 10.0);
  assert.equal(m.bb9, 2.25);
  assert.equal(m.hr9, 0.75);
  assert.equal(m.h9, 7.5);
  assert.equal(m.kPct, 0.278);
  assert.equal(m.kMinusBbPct, 0.215);
  assert.equal(m.babip, 0.3);
  assert.equal(m.lobPct, 0.749);
  assert.equal(m.hrPerFB, 0.075);
});

test("rates that need hits stay null when hits absent (fail-quiet, not fake)", () => {
  const noHits: RawPitchingLine = {
    inningsPitched: "50.0",
    strikeOuts: 60,
    baseOnBalls: 15,
    homeRuns: 5,
  };
  const m = computePitchingMetrics(noHits, 2023);
  assert.equal(m.whip, null);
  assert.equal(m.babip, null);
  assert.equal(m.era, null);
  // FIP only needs K/BB/HR/IP, so it still computes.
  assert.notEqual(m.fip, null);
});
