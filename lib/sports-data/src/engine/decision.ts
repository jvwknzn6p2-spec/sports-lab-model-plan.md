/**
 * Decision engine + probability calibration.
 *
 * Turns simulation output into an actionable, honest pick:
 *   - calibrate the raw win probability (shrink toward 50% by a learned factor)
 *   - pick winner / predicted loser / handicap side
 *   - assign confidence S/A/B/C from edge size, data completeness, reliability
 *   - emit PASS instead of a pick when uncertainty is too high
 *   - explain itself with plain-language reasons
 */

import type { GameCoreData } from "../step2";
import type { RunExpectation } from "./run-model";
import type { SimulationResult } from "./simulate";

export type Confidence = "S" | "A" | "B" | "C";

/** Handicap line for one game, sportsbook convention (side gives the line). */
export interface HandicapInput {
  side: "home" | "away";
  line: number; // e.g. -1.5 on the favorite
  total?: number; // over/under line, optional
}

/**
 * Learned calibration state (the "self-learning" part of the loop).
 *
 * Each market gets its OWN shrink, because they are not equally well
 * modelled: a Monte Carlo win probability can be well calibrated while the
 * run-line cover probability is systematically overconfident (margin is
 * harder to predict than the winner). Learning them together would let one
 * market's error corrupt the others.
 */
export interface CalibrationState {
  /** Shrink of (p−0.5) for the moneyline: 1 = trust fully, 0.5 = halve. */
  shrink: number;
  /** Same, for the handicap / run-line cover probability. */
  handicapShrink: number;
  /** Same, for the over/under total. */
  totalShrink: number;
  gamesSettled: number;
  brierSum: number;
  updatedAt: string | null;
}

export const DEFAULT_CALIBRATION: CalibrationState = {
  shrink: 0.85,
  handicapShrink: 0.85,
  totalShrink: 0.85,
  gamesSettled: 0,
  brierSum: 0,
  updatedAt: null,
};

/**
 * Fill in markets missing from an older calibration.json (which only had a
 * single `shrink`), so upgrading never silently resets learned state.
 */
export function normalizeCalibration(
  raw: Partial<CalibrationState> & { shrink?: number },
): CalibrationState {
  const shrink = raw.shrink ?? DEFAULT_CALIBRATION.shrink;
  return {
    shrink,
    handicapShrink: raw.handicapShrink ?? shrink,
    totalShrink: raw.totalShrink ?? shrink,
    gamesSettled: raw.gamesSettled ?? 0,
    brierSum: raw.brierSum ?? 0,
    updatedAt: raw.updatedAt ?? null,
  };
}

export interface DecisionConfig {
  /** Below this calibrated win probability the game is a PASS. */
  passThreshold: number;
  /** Confidence bands on the calibrated win probability. */
  bandS: number;
  bandA: number;
  bandB: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  passThreshold: 0.55,
  bandS: 0.65,
  bandA: 0.6,
  bandB: 0.55,
};

export interface GamePrediction {
  gamePk: number;
  gameDate: string | null;
  home: string;
  away: string;
  pass: boolean;
  predictedWinner: string | null;
  predictedLoser: string | null;
  winProbability: number; // calibrated, for the predicted winner
  rawWinProbability: number;
  confidence: Confidence;
  handicap: {
    input: HandicapInput | null;
    pick: string | null; // e.g. "home -1.5" or "away +1.5"
    coverProbability: number | null;
  };
  total: {
    line: number | null;
    predicted: number;
    pick: "OVER" | "UNDER" | null;
    probability: number | null;
  };
  expectedRuns: { home: number; away: number };
  reasons: string[];
  flags: string[];
}

/** Pull a raw probability toward 50% by the market's learned shrink. */
export function calibrate(pRaw: number, shrink: number): number {
  return 0.5 + (pRaw - 0.5) * shrink;
}

function confidenceFor(
  p: number,
  g: GameCoreData,
  cfg: DecisionConfig,
): Confidence {
  let c: Confidence =
    p >= cfg.bandS ? "S" : p >= cfg.bandA ? "A" : p >= cfg.bandB ? "B" : "C";
  // Data quality caps: incomplete or downgraded games can never be S/A.
  const hasDowngrade = g.flags.some((f) => f.severity === "downgrade");
  if (!g.complete || hasDowngrade) return "C";
  const minReliability = Math.min(
    g.home.starter?.reliability ?? 0,
    g.away.starter?.reliability ?? 0,
    g.home.batting?.reliability ?? 0,
    g.away.batting?.reliability ?? 0,
  );
  if (minReliability < 0.5 && (c === "S" || c === "A")) c = "B";
  return c;
}

function buildReasons(
  g: GameCoreData,
  runs: RunExpectation,
  sim: SimulationResult,
): string[] {
  const reasons: string[] = [];
  const hs = g.home.starter;
  const as = g.away.starter;
  if (
    hs?.projectedFip !== undefined &&
    as?.projectedFip !== undefined &&
    hs &&
    as
  ) {
    const diff = as.projectedFip - hs.projectedFip;
    if (Math.abs(diff) >= 0.25) {
      const better = diff > 0 ? g.home : g.away;
      const b = diff > 0 ? hs : as;
      const w = diff > 0 ? as : hs;
      reasons.push(
        `Starter edge: ${better.teamName} (${b.pitcherName ?? "SP"} projFIP ${b.projectedFip.toFixed(2)} vs ${w.projectedFip.toFixed(2)})`,
      );
    }
  }
  const hb = g.home.batting;
  const ab = g.away.batting;
  if (hb && ab && Math.abs(hb.projectedWoba - ab.projectedWoba) >= 0.008) {
    const better = hb.projectedWoba > ab.projectedWoba ? g.home : g.away;
    const bw = Math.max(hb.projectedWoba, ab.projectedWoba);
    const ww = Math.min(hb.projectedWoba, ab.projectedWoba);
    reasons.push(
      `Offense edge: ${better.teamName} (wOBA ${bw.toFixed(3)} vs ${ww.toFixed(3)})`,
    );
  }
  const hp = g.home.bullpen;
  const ap = g.away.bullpen;
  if (
    hp &&
    ap &&
    Math.abs(hp.expectedRunsAllowedPer9 - ap.expectedRunsAllowedPer9) >= 0.3
  ) {
    const better =
      hp.expectedRunsAllowedPer9 < ap.expectedRunsAllowedPer9 ? g.home : g.away;
    reasons.push(`Bullpen edge: ${better.teamName}`);
  }
  for (const t of [g.home, g.away]) {
    if (t.bullpen && t.bullpen.fatiguePenalty > 0) {
      reasons.push(
        `${t.teamName} bullpen fatigued (+${t.bullpen.fatiguePenalty.toFixed(2)} R/9)`,
      );
    }
  }
  if (g.parkFactor !== 100) {
    reasons.push(
      `Park factor ${g.parkFactor} (${g.parkFactor > 100 ? "hitter" : "pitcher"}-friendly)`,
    );
  }
  reasons.push(
    `Expected runs ${runs.homeMu.toFixed(2)}–${runs.awayMu.toFixed(2)} over ${sim.sims} sims`,
  );
  reasons.push(...runs.notes);
  return reasons;
}

export function decide(
  g: GameCoreData,
  runs: RunExpectation,
  sim: SimulationResult,
  calibration: CalibrationState,
  handicap: HandicapInput | null,
  cfg: DecisionConfig = DEFAULT_DECISION_CONFIG,
): GamePrediction {
  const homeName = g.home.teamName ?? "home";
  const awayName = g.away.teamName ?? "away";

  const pHomeCal = calibrate(sim.pHomeWin, calibration.shrink);
  const homeFavored = pHomeCal >= 0.5;
  const pWinner = homeFavored ? pHomeCal : 1 - pHomeCal;
  const winner = homeFavored ? homeName : awayName;
  const loser = homeFavored ? awayName : homeName;

  const confidence = confidenceFor(pWinner, g, cfg);
  const hasDowngrade = g.flags.some((f) => f.severity === "downgrade");
  const pass = pWinner < cfg.passThreshold || !g.complete || hasDowngrade;

  // Handicap: probability the QUOTED side covers its line (calibrated).
  let handicapPick: string | null = null;
  let coverProbability: number | null = null;
  if (handicap) {
    const pCoverRaw = sim.coverProb(handicap.side, handicap.line);
    const pCover = calibrate(pCoverRaw, calibration.handicapShrink);
    const sideName = handicap.side === "home" ? homeName : awayName;
    const otherName = handicap.side === "home" ? awayName : homeName;
    const otherLine = -handicap.line;
    if (pCover >= 0.5) {
      handicapPick = `${sideName} ${fmtLine(handicap.line)}`;
      coverProbability = round3(pCover);
    } else {
      handicapPick = `${otherName} ${fmtLine(otherLine)}`;
      coverProbability = round3(1 - pCover);
    }
  }

  // Total.
  let totalPick: "OVER" | "UNDER" | null = null;
  let totalProbability: number | null = null;
  const totalLine = handicap?.total ?? null;
  if (totalLine !== null) {
    const { over } = sim.totalProb(totalLine);
    const pOver = calibrate(over, calibration.totalShrink);
    totalPick = pOver >= 0.5 ? "OVER" : "UNDER";
    totalProbability = round3(pOver >= 0.5 ? pOver : 1 - pOver);
  }

  const reasons = buildReasons(g, runs, sim);
  if (pass) {
    reasons.unshift(
      !g.complete || hasDowngrade
        ? "PASS: incomplete/downgraded data"
        : `PASS: edge too small (win prob ${(pWinner * 100).toFixed(1)}% < ${(cfg.passThreshold * 100).toFixed(0)}%)`,
    );
  }

  return {
    gamePk: g.gamePk,
    gameDate: g.gameDate,
    home: homeName,
    away: awayName,
    pass,
    predictedWinner: pass ? null : winner,
    predictedLoser: pass ? null : loser,
    winProbability: round3(pWinner),
    rawWinProbability: round3(homeFavored ? sim.pHomeWin : sim.pAwayWin),
    confidence,
    handicap: {
      input: handicap,
      pick: pass ? null : handicapPick,
      coverProbability,
    },
    total: {
      line: totalLine,
      predicted: round2(sim.meanTotal),
      pick: pass ? null : totalPick,
      probability: totalProbability,
    },
    expectedRuns: { home: runs.homeMu, away: runs.awayMu },
    reasons,
    flags: g.flags.map((f) => `[${f.severity}] ${f.code}`),
  };
}

const fmtLine = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
