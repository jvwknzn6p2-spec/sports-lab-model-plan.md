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
  line?: number | null;
  notation?: string | null;
  total?: number | null; // over/under line, optional
}

/**
 * True when the input actually carries a line.
 *
 * A control-tower skeleton writes `notation: null` — "no line has been
 * entered yet" — and that is NOT the same claim as `"0"`, which is a
 * deliberate pick'em quote. An unentered line means there is no handicap
 * market to price for this game: quoting it as 0 would silently re-run the
 * moneyline under the handicap's name, which is exactly what 24 straight
 * all-zero control towers in the live record did (every "handicap" bet on
 * the book through 2026-08-20 settled identically to the winner pick).
 */
export function hasQuotedLine(h: HandicapInput | null | undefined): boolean {
  return h != null && (h.notation != null || h.line != null);
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
  if (h.notation != null && h.line != null) {
    throw new HandicapNotationError(
      h.notation,
      "give either `notation` or `line`, not both — they can disagree",
    );
  }
  if (h.notation != null) {
    const p = parseHandicapNotation(h.notation);
    // The notation says what the side GIVES, so its own lines are negative.
    return {
      parts: oppositeParts(p.parts),
      giveLabel: `-〈${p.notation}〉`,
      takeLabel: `+〈${p.notation}〉`,
      effectiveLine: -p.effectiveLine,
    };
  }
  if (h.line != null) {
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
 * Raw probability at which the tail band begins.
 *
 * 0.65 is where the PRE-REFIT record's calibration curve broke: below it the
 * quotes tracked reality, above it they collapsed (stated 66%, hit 42% over
 * 19 bets). The refit simulator (r=4.5, no shared environment factor) removed
 * that break — see DEFAULT_TAIL_SHRINK — but the boundary is kept where it is
 * because nothing in the new record argues for moving it, and moving it would
 * re-band every stored tail stamp for no measured gain.
 */
export const TAIL_START = 0.65;

/**
 * Default tail shrink: the SAME as the core, i.e. a deliberately neutral
 * prior.
 *
 * It used to be 0.7, below the core's 0.85, encoding the heavy tail
 * overconfidence the 2026-08 audit measured. That overconfidence was a
 * symptom of independent-Poisson variance, not a property of the tail, and
 * the refit removed it. Over 1,501 walk-forward bets on the real 2024–2025
 * record under the refit engine the top of the book is if anything
 * CONSERVATIVE, not bold:
 *
 *   stated 0.600–0.625  n=262  hit 60.3%
 *   stated 0.625–0.650  n=164  hit 68.9%
 *   stated 0.650–0.675  n= 60  hit 71.7%
 *   stated ≥0.675       n= 61  hit 72.1%
 *
 * Keeping a punitive prior against that evidence would systematically
 * under-quote the model's best picks. Starting level and letting bounded
 * learning (settle.ts) move it is what the data supports.
 */
const DEFAULT_TAIL_SHRINK = 0.85;

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
 * min(its core shrink, DEFAULT_TAIL_SHRINK) — never above the core, because
 * quoting the far edge MORE boldly than the near edge is a claim the record
 * has never supported, and never above the neutral prior either.
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

/**
 * Bands cut where the REAL record separates, on the refit engine's scale.
 *
 * The old S cut of 0.65 was set on the pre-refit probability scale, which ran
 * hot. Once the simulator was refit the quotes stopped reaching it: over
 * 1,501 walk-forward bets across 2024-05→08, 2025-05→06 and 2025-07→08, S
 * collected 8 picks — 0.5% of the book — so the top band carried no
 * information and the report's headline breakdown was effectively two bands
 * wide.
 *
 * Re-cut at 0.625, the same record separates cleanly and monotonically, and
 * every band clears the 52.63% break-even of a 0.9-paying win:
 *
 *   S  ≥0.625        n=285  hit 70.2%   EV +0.333 / unit
 *   A  0.600–0.625   n=262  hit 60.3%   EV +0.146 / unit
 *   B  0.550–0.600   n=954  hit 54.9%   EV +0.044 / unit
 *
 * (Those are the raw band populations; the data-quality caps in
 * `confidenceFor` demote a further share of them, which is intended — the
 * bands describe the price, the caps describe the inputs.)
 *
 * `passThreshold` stays at 0.55 on the same evidence: B is the marginal band
 * at +0.044/unit and the slice immediately above the cut (0.550–0.575, n=576)
 * runs 53.3%, i.e. +0.013/unit — already inside the noise. Lowering the gate
 * toward the 52.63% break-even would buy an unmeasured population that the
 * trend says is worth nothing or less. The positive-EV handicaps this gate
 * used to discard are recovered by decoupling the markets in `decide`, not by
 * loosening the winner bar.
 */
export const DEFAULT_DECISION_CONFIG: DecisionConfig = {
  passThreshold: 0.55,
  minEv: 0,
  bandS: 0.625,
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

/**
 * The tail band must EARN the S label.
 *
 * `tailShrink` is the system's own running measurement of its top-band
 * quotes: bounded learning (settle.ts) drives it this far below the neutral
 * 0.85 prior only after those quotes have repeatedly overstated reality.
 * While that is the case, an S badge is a claim the record just contradicted
 * — on the live 2026-08 book S ran 9-13 (40.9%, −4.90 units) UNDER A's 63.0%
 * and B's 58.2%, and the stated 65–70% band hit 37.5% over 24 bets. So S is
 * capped at A until the winner tail learns its way back above this floor;
 * the ladder can then be trusted to rank again.
 */
export const TAIL_TRUST_FLOOR = 0.75;

function confidenceFor(
  p: number,
  g: GameCoreData,
  cfg: DecisionConfig,
  calibration: CalibrationState,
): Confidence {
  let c: Confidence =
    p >= cfg.bandS ? "S" : p >= cfg.bandA ? "A" : p >= cfg.bandB ? "B" : "C";
  if (c === "S" && calibration.tailShrink < TAIL_TRUST_FLOOR) c = "A";
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

  const confidence = confidenceFor(pWinner, g, cfg, calibration);
  const hasDowngrade = g.flags.some((f) => f.severity === "downgrade");

  // Handicap: probability the QUOTED side covers its line (calibrated), and
  // what that is actually worth once the house takes its cut.
  let handicapPick: string | null = null;
  let coverProbability: number | null = null;
  let rawCoverProbability: number | null = null;
  let handicapEv: number | null = null;
  /**
   * True when every part of the quoted line sits on 0 — a pick'em, which is
   * not a handicap at all: it is the moneyline with the stake returned on a
   * level score. Measured on the live record, 143 of 143 settled handicaps at
   * a 0 line produced the identical result to the winner pick, and the two
   * lifetime records are the same number (81-62 / 81-62). Everything below
   * that treats the handicap as an INDEPENDENT market has to know this,
   * because at a 0 line it is not one.
   */
  let handicapIsPickem = false;
  // An input with no line entered (skeleton `notation: null`) quotes NO
  // handicap market at all — see `hasQuotedLine`. Its `total`, if any, still
  // counts below.
  if (handicap && hasQuotedLine(handicap)) {
    const r = resolveHandicap(handicap);
    handicapIsPickem = r.parts.every((p) => p.line === 0);
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

  // Two different reasons to sit out, and they do NOT bind the same markets.
  //
  // `dataPass` is a statement about the INPUTS: the game is incomplete or a
  // downgrade flag fired, so nothing priced off it can be trusted and every
  // market is off.
  //
  // `pass` adds the thin-winner-edge gate. That gate is a statement about ONE
  // market — it says the moneyline is not worth backing — and it is applied
  // to the moneyline and the total, which are both priced off who wins and
  // by how much in the same direction.
  //
  // It is NOT applied to a handicap quoted at a REAL line, for the same
  // reason `handicapUnprofitable` is deliberately not folded into `pass`
  // below: the run line is a separate bet at a separate price, and its value
  // comes from the LINE, not from the size of the winner edge. A 53%
  // favourite laid at a generous number is a real edge; discarding it because
  // the moneyline is dull throws away the market this tool exists to price.
  // (Measured on the 2026-08-17 slate: three of eight PASSes carried handicap
  // EV of +2.2%, +4.6% and +1.4%, all discarded by the winner gate alone.)
  //
  // At a PICK'EM it is applied, because there is then no separate bet to
  // protect — see `handicapSuppressed`.
  const dataPass = !g.complete || hasDowngrade;
  const pass = pWinner < cfg.passThreshold || dataPass;

  /**
   * Which gate the handicap answers to.
   *
   * A real line is its own bet and only bad INPUTS can kill it. A pick'em is
   * the moneyline wearing a different name, so exempting it from the winner
   * gate does not recover a separate edge — it re-enters the exact
   * proposition the winner gate just rejected, through the back door, at a
   * probability the record says is worth nothing. (On 2026-08-18 that put
   * three stakes on the book at 54.2%, 53.4% and 53.7%, all below the 55%
   * bar the same slate had just applied to those same games, and tripled the
   * day's exposure from 3 stakes to 10.) So: a pick'em is gated exactly like
   * the moneyline, and the market decoupling switches itself back on the
   * moment a real line is quoted.
   */
  const handicapSuppressed = dataPass || (handicapIsPickem && pass);

  // Distrust-your-own-enthusiasm guard: an EV far beyond what a real edge
  // over a real market looks like is more likely a modelling error than a
  // gift (see EV_OUTLIER_THRESHOLD). Cap the confidence so the pick can never
  // present as S/A on the strength of the very number under suspicion.
  //
  // It cannot say anything at a pick'em, where there is no market price to
  // disagree with: EV is then a monotone restatement of the win probability
  // (p·0.9 − (1−p)), so the 0.25 threshold silently becomes "cover > 65.8%"
  // and demotes the model's BEST picks — inverting the confidence ladder
  // right at the top of the book, where a 66% pick would rank below a 63%
  // one. Overconfidence at a pick'em is the tail band's job, not this one's.
  const evOutlier =
    handicapEv !== null &&
    !handicapSuppressed &&
    !handicapIsPickem &&
    handicapEv > EV_OUTLIER_THRESHOLD;
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
  if (handicap && !hasQuotedLine(handicap)) {
    reasons.unshift(
      "No handicap line entered — run line not quoted (moneyline and total only)",
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
    const handicapSurvives =
      !handicapSuppressed && handicapEv !== null && !handicapUnprofitable;
    reasons.unshift(
      dataPass
        ? "PASS: incomplete/downgraded data"
        : `PASS: edge too small (win prob ${(pWinner * 100).toFixed(1)}% < ` +
            `${(cfg.passThreshold * 100).toFixed(0)}%) — moneyline and total only` +
            (handicapSurvives
              ? `; the handicap below is priced on its own line and still stands`
              : ""),
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
      pick: handicapSuppressed || handicapUnprofitable ? null : handicapPick,
      coverProbability,
      rawCoverProbability,
      ev: handicapEv,
      noValue: !handicapSuppressed && handicapUnprofitable,
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
