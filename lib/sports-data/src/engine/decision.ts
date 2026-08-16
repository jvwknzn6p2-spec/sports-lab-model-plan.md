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
import { breakEvenProbability, expectedValueFromProbability } from "./ev";
import {
  HandicapNotationError,
  oppositeParts,
  parseHandicapNotation,
  splitLine,
  WIN_COMMISSION,
  type WeightedLine,
} from "./handicap-notation";

export type Confidence = "S" | "A" | "B" | "C";

/**
 * The handicap quoted on one game.
 *
 * Two ways to state it, and exactly one must be given:
 *
 *   `notation` — the market's own form, as written on the slate: "0.8",
 *     "1半", "1半2", "〈1.4〉, "なし". UNSIGNED: it is the handicap `side`
 *     GIVES, which is how the line is actually quoted. 〈1半2〉 on the home
 *     side means home −1.5 with 20% of the stake on home −2.
 *
 *   `line` — a signed sportsbook number (−1.5 on the favourite). Kept because
 *     the run line is what the MLB feed and older control towers speak.
 */
export interface HandicapInput {
  side: "home" | "away";
  line?: number;
  notation?: string;
  total?: number; // over/under line, optional
}

/** A handicap reduced to the weighted lines it settles as. */
export interface ResolvedHandicap {
  /** Signed lines from the QUOTED side's perspective. */
  parts: WeightedLine[];
  /** How the quoted side's bet is written, e.g. "-1.5" or "-〈1半2〉". */
  giveLabel: string;
  /** How the other side's bet is written. */
  takeLabel: string;
  /** Stake-weighted signed line, for display and ordering. */
  effectiveLine: number;
}

/**
 * Turn either input form into the one thing everything downstream needs: a
 * basket of signed, weighted lines belonging to the quoted side.
 *
 * Resolving in ONE place is the point. The simulator prices these parts, the
 * settler scores them, and the report names them; deriving them separately
 * anywhere would let a 半 line be quoted as a split stake and settled as a
 * plain one.
 */
export function resolveHandicap(h: HandicapInput): ResolvedHandicap {
  if (h.notation !== undefined && h.line !== undefined) {
    throw new HandicapNotationError(
      h.notation,
      "give either `notation` or `line`, not both — they can disagree",
    );
  }
  if (h.notation !== undefined) {
    const p = parseHandicapNotation(h.notation);
    // The notation says what the side GIVES, so its own lines are negative.
    return {
      parts: oppositeParts(p.parts),
      giveLabel: `-〈${p.notation}〉`,
      takeLabel: `+〈${p.notation}〉`,
      effectiveLine: -p.effectiveLine,
    };
  }
  if (h.line !== undefined) {
    return {
      parts: splitLine(h.line),
      giveLabel: fmtLine(h.line),
      takeLabel: fmtLine(-h.line),
      effectiveLine: h.line,
    };
  }
  throw new HandicapNotationError(
    JSON.stringify(h),
    'no line given — set `notation` (e.g. "1半2") or `line` (e.g. -1.5)',
  );
}

/**
 * Learned calibration state (the "self-learning" part of the loop).
 *
 * Each market gets its OWN shrink, because they are not equally well
 * modelled: a Monte Carlo win probability can be well calibrated while the
 * run-line cover probability is systematically overconfident (margin is
 * harder to predict than the winner). Learning them together would let one
 * market's error corrupt the others.
 *
 * Each market also gets its own TAIL shrink, applied to the part of the edge
 * above `TAIL_START`. A single linear shrink cannot express what the settled
 * record actually showed — quotes in the 55–60% band running BELOW reality
 * while quotes above 65% ran far above it — because tightening the one factor
 * to fix the tail breaks the (already accurate) core, and vice versa. Two
 * factors, each learned only from its own band's bets, can.
 */
export interface CalibrationState {
  /** Shrink of (p−0.5) for the moneyline: 1 = trust fully, 0.5 = halve. */
  shrink: number;
  /** Extra shrink on the edge beyond TAIL_START (moneyline). */
  tailShrink: number;
  /** Same, for the handicap / run-line cover probability. */
  handicapShrink: number;
  handicapTailShrink: number;
  /** Same, for the over/under total. */
  totalShrink: number;
  totalTailShrink: number;
  gamesSettled: number;
  brierSum: number;
  updatedAt: string | null;
}

/**
 * Raw probability at which the tail band begins. 0.65 is where the settled
 * record's calibration curve broke: below it the model's quotes tracked
 * reality, above it they collapsed (stated 66%, hit 42% over 19 bets).
 */
export const TAIL_START = 0.65;

/**
 * Default tail shrink. Deliberately BELOW the core's 0.85: the 2026-08 audit
 * measured heavy tail overconfidence, and a fresh state should start from
 * that evidence rather than relearn it at live stakes. Bounded learning
 * (settle.ts) moves it from here.
 */
const DEFAULT_TAIL_SHRINK = 0.7;

export const DEFAULT_CALIBRATION: CalibrationState = {
  shrink: 0.85,
  tailShrink: DEFAULT_TAIL_SHRINK,
  handicapShrink: 0.85,
  handicapTailShrink: DEFAULT_TAIL_SHRINK,
  totalShrink: 0.85,
  totalTailShrink: DEFAULT_TAIL_SHRINK,
  gamesSettled: 0,
  brierSum: 0,
  updatedAt: null,
};

/**
 * Fill in markets missing from an older calibration.json (which only had a
 * single `shrink`, then per-market shrinks without tails), so upgrading never
 * silently resets learned state.
 *
 * A legacy file has no tail values; each market's tail starts at
 * min(its core shrink, DEFAULT_TAIL_SHRINK) — inheriting the core alone would
 * reproduce the exact tail overconfidence the tail band exists to fix, while
 * a tail above the core would mean quoting the far edge MORE boldly than the
 * near edge, which no evidence supports.
 */
export function normalizeCalibration(
  raw: Partial<CalibrationState> & { shrink?: number },
): CalibrationState {
  const shrink = raw.shrink ?? DEFAULT_CALIBRATION.shrink;
  const handicapShrink = raw.handicapShrink ?? shrink;
  const totalShrink = raw.totalShrink ?? shrink;
  const legacyTail = (core: number) => Math.min(core, DEFAULT_TAIL_SHRINK);
  return {
    shrink,
    tailShrink: raw.tailShrink ?? legacyTail(shrink),
    handicapShrink,
    handicapTailShrink: raw.handicapTailShrink ?? legacyTail(handicapShrink),
    totalShrink,
    totalTailShrink: raw.totalTailShrink ?? legacyTail(totalShrink),
    gamesSettled: raw.gamesSettled ?? 0,
    brierSum: raw.brierSum ?? 0,
    updatedAt: raw.updatedAt ?? null,
  };
}

export interface DecisionConfig {
  /** Below this calibrated win probability the game is a PASS. */
  passThreshold: number;
  /**
   * Minimum profit per unit staked for a handicap to be offered. 0 means
   * "must at least break even after the cut"; raise it to demand a margin
   * over the noise in the model's own probability.
   */
  minEv: number;
  /** Confidence bands on the calibrated win probability. */
  bandS: number;
  bandA: number;
  bandB: number;
}

export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  passThreshold: 0.55,
  minEv: 0,
  bandS: 0.65,
  bandA: 0.6,
  bandB: 0.55,
};

/**
 * Above this, a quoted EV is treated as a symptom rather than a prize.
 *
 * The settled record's EV buckets ran 60.6% (+5–15%), 66.7% (+15–25%), then
 * 42.1% (>+25%, n=19): when the model believes it has found a much better
 * price than the market, the discrepancy has so far been the MODEL's error,
 * not the market's. Such picks keep their bet (the sign of the edge is still
 * information) but are capped at confidence B, flagged, and demoted in the
 * recommendation order.
 */
export const EV_OUTLIER_THRESHOLD = 0.25;

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
    /**
     * The pick's cover probability BEFORE calibration. Kept so settlement can
     * band the bet (core vs tail) by what the simulator actually said, not by
     * inverting a calibration map that may have drifted since the pick.
     */
    rawCoverProbability: number | null;
    /** Profit per unit staked after the house's cut. Negative = losing bet. */
    ev: number | null;
    /**
     * A line was quoted, the model has an opinion about it, and that opinion
     * is not worth backing at this price. Distinct from `pass`: the game is
     * still predicted and still scored — only this one market is skipped.
     */
    noValue: boolean;
  };
  total: {
    line: number | null;
    predicted: number;
    pick: "OVER" | "UNDER" | null;
    probability: number | null;
    /** Uncalibrated probability of the chosen side, for banding (see above). */
    rawProbability: number | null;
  };
  expectedRuns: { home: number; away: number };
  reasons: string[];
  flags: string[];
  /** 22:55 JST the evening before: when this pick stopped being editable. */
  lockDeadline?: string | null;
  /** True once the deadline has passed and the pick is frozen. */
  final?: boolean;
}

/** Pull a raw probability toward 50% by the market's learned shrink. */
export function calibrate(pRaw: number, shrink: number): number {
  return 0.5 + (pRaw - 0.5) * shrink;
}

/**
 * Banded calibration: piecewise-LINEAR and CONTINUOUS in the edge |p − 0.5|.
 *
 * The edge up to (TAIL_START − 0.5) is scaled by the core shrink; whatever
 * lies beyond is scaled by the tail shrink. Gluing the segments (rather than
 * switching wholesale at the boundary) keeps the map continuous and, for
 * positive shrinks, strictly monotone — a raw 65.1% can never be quoted below
 * a raw 64.9%. Symmetric around 50%, so it is side-agnostic: calibrating
 * p(home) and 1 − p(away) agree.
 */
export function calibrateBanded(
  pRaw: number,
  coreShrink: number,
  tailShrink: number,
): number {
  const edge = Math.abs(pRaw - 0.5);
  const coreSpan = TAIL_START - 0.5;
  const scaled =
    edge <= coreSpan
      ? edge * coreShrink
      : coreSpan * coreShrink + (edge - coreSpan) * tailShrink;
  return 0.5 + Math.sign(pRaw - 0.5) * scaled;
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

  const pHomeCal = calibrateBanded(
    sim.pHomeWin,
    calibration.shrink,
    calibration.tailShrink,
  );
  const homeFavored = pHomeCal >= 0.5;
  const pWinner = homeFavored ? pHomeCal : 1 - pHomeCal;
  const winner = homeFavored ? homeName : awayName;
  const loser = homeFavored ? awayName : homeName;

  const confidence = confidenceFor(pWinner, g, cfg);
  const hasDowngrade = g.flags.some((f) => f.severity === "downgrade");

  // Handicap: probability the QUOTED side covers its line (calibrated), and
  // what that is actually worth once the house takes its cut.
  let handicapPick: string | null = null;
  let coverProbability: number | null = null;
  let rawCoverProbability: number | null = null;
  let handicapEv: number | null = null;
  if (handicap) {
    const r = resolveHandicap(handicap);
    const quoted = sim.asianCover(handicap.side, r.parts);
    const pCover = calibrateBanded(
      quoted.probability,
      calibration.handicapShrink,
      calibration.handicapTailShrink,
    );
    // Back whichever side the model prefers. The push share is a property of
    // the line itself, so it is the same whichever side of it you take — but
    // it is NOT the same for a 半 line as for the whole line it resembles,
    // which is exactly why the parts are priced rather than the number.
    const takeQuoted = pCover >= 0.5;
    const chosen = takeQuoted ? pCover : 1 - pCover;
    handicapPick = takeQuoted
      ? `${handicap.side === "home" ? homeName : awayName} ${r.giveLabel}`
      : `${handicap.side === "home" ? awayName : homeName} ${r.takeLabel}`;
    coverProbability = round3(chosen);
    rawCoverProbability = round3(
      takeQuoted ? quoted.probability : 1 - quoted.probability,
    );
    handicapEv = round3(expectedValueFromProbability(chosen, quoted.push));
  }

  const pass = pWinner < cfg.passThreshold || !g.complete || hasDowngrade;

  // Distrust-your-own-enthusiasm guard: an EV far beyond what a real edge
  // over a real market looks like is more likely a modelling error than a
  // gift (see EV_OUTLIER_THRESHOLD). Cap the confidence so the pick can never
  // present as S/A on the strength of the very number under suspicion.
  const evOutlier =
    handicapEv !== null && !pass && handicapEv > EV_OUTLIER_THRESHOLD;
  const confidenceCapped =
    evOutlier && (confidence === "S" || confidence === "A")
      ? "B"
      : confidence;

  // A handicap quoted at a price that cannot clear the house's cut is not a
  // bet, however confident the model is about who wins: winning 60% of a
  // market that pays 0.9 on a win still loses money.
  //
  // This suppresses THIS MARKET ONLY — it deliberately does not set `pass`.
  // A bad price on the run line says nothing about who wins or how many runs
  // are scored, and folding it into `pass` would null out the moneyline and
  // the total as well. It would also stop the settler scoring the game at
  // all (settle.ts skips passed games), so a stretch of poorly priced lines
  // would freeze every market's learned shrink — the model would stop
  // learning who wins because of a price on a different bet.
  const handicapUnprofitable = handicapEv !== null && handicapEv <= cfg.minEv;

  // Total.
  let totalPick: "OVER" | "UNDER" | null = null;
  let totalProbability: number | null = null;
  let rawTotalProbability: number | null = null;
  const totalLine = handicap?.total ?? null;
  if (totalLine !== null) {
    const { over } = sim.totalProb(totalLine);
    const pOver = calibrateBanded(
      over,
      calibration.totalShrink,
      calibration.totalTailShrink,
    );
    totalPick = pOver >= 0.5 ? "OVER" : "UNDER";
    totalProbability = round3(pOver >= 0.5 ? pOver : 1 - pOver);
    rawTotalProbability = round3(pOver >= 0.5 ? over : 1 - over);
  }

  const reasons = buildReasons(g, runs, sim);
  if (evOutlier) {
    reasons.unshift(
      `EV outlier: ${fmtPct(handicapEv!)} per unit is implausibly large — ` +
        `edges this size have historically been model error, not value ` +
        `(confidence capped at B, rank demoted)`,
    );
  }
  if (handicapEv !== null) {
    reasons.unshift(
      handicapUnprofitable
        ? `No handicap bet: ${fmtPct(handicapEv)} per unit at this line ` +
            `(needs ${(breakEvenProbability() * 100).toFixed(1)}% to break even ` +
            `after the ${WIN_COMMISSION * 100}% cut)`
        : `Handicap EV ${fmtPct(handicapEv)} per unit ` +
            `(needs ${(breakEvenProbability() * 100).toFixed(1)}% to break even ` +
            `after the ${WIN_COMMISSION * 100}% cut)`,
    );
  }
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
    confidence: confidenceCapped,
    handicap: {
      input: handicap,
      pick: pass || handicapUnprofitable ? null : handicapPick,
      coverProbability,
      rawCoverProbability,
      ev: handicapEv,
      noValue: !pass && handicapUnprofitable,
    },
    total: {
      line: totalLine,
      predicted: round2(sim.meanTotal),
      pick: pass ? null : totalPick,
      probability: totalProbability,
      rawProbability: rawTotalProbability,
    },
    expectedRuns: { home: runs.homeMu, away: runs.awayMu },
    reasons,
    flags: [
      ...g.flags.map((f) => `[${f.severity}] ${f.code}`),
      ...(evOutlier ? ["[warn] ev_outlier"] : []),
    ],
  };
}

const fmtLine = (l: number) => (l > 0 ? `+${l}` : `${l}`);
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * A signed percentage. EV is the one number here that is routinely negative,
 * and "-3.1%" versus "3.1%" is the difference between a bet and a refusal, so
 * the sign is always shown rather than left to the minus sign alone.
 */
export const fmtPct = (v: number) =>
  `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

/** A signed stake figure in units, e.g. "+0.72" for 〈1半2〉 winning by two. */
export const fmtUnits = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

/**
 * EV as used for ORDERING picks: honest up to the outlier threshold, then
 * reflected back down — an EV of +40% ranks like +10%, not like the best bet
 * of the day.
 *
 * The reflection (rather than a flat cap) encodes what the settled record
 * showed: credibility falls off monotonically past the threshold, and a cap
 * would still put every outlier above every honest +24% pick. The bet itself
 * is unchanged; only its place in the queue is.
 */
export function rankingEv(ev: number): number {
  return ev <= EV_OUTLIER_THRESHOLD ? ev : 2 * EV_OUTLIER_THRESHOLD - ev;
}

/**
 * Recommendation order: best expected value first.
 *
 * This lives here rather than in each renderer because the order IS part of
 * the prediction — the report headings and the Pick Tracker paste block are
 * numbered from it, and two renderers sorting independently produced two
 * different "#3" for the same slate.
 *
 * Sorting by win probability instead would promote a near-certain bet that
 * pays almost nothing over a genuinely profitable one, which is the mistake
 * this ordering exists to prevent. Games with no line quoted have no EV at
 * all; they sort below every real price (a reflected outlier EV cannot fall
 * below 2·threshold − 0.9 ≈ −0.4, and a real losing price not below −1) and
 * fall back to confidence among themselves.
 */
export function rankByValue(
  picks: readonly GamePrediction[],
): GamePrediction[] {
  const rank = { S: 0, A: 1, B: 2, C: 3 } as const;
  const ev = (p: GamePrediction) =>
    p.handicap.ev === null ? -2 : rankingEv(p.handicap.ev);
  return [...picks].sort(
    (a, b) =>
      ev(b) - ev(a) ||
      rank[a.confidence] - rank[b.confidence] ||
      b.winProbability - a.winProbability,
  );
}
