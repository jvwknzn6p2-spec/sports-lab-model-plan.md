/**
 * Settlement → error analysis → self-learning (post-game loop).
 *
 * Given a locked prediction file and final scores:
 *   - score every non-PASS pick (winner, handicap, total)
 *   - compute per-game and aggregate error metrics (Brier, margin/total error)
 *   - update the calibration state: if the model's stated probabilities were
 *     overconfident (actual win rate below stated), shrink future edges;
 *     if underconfident, expand them. Bounded, small steps (v1 self-learning).
 */

import { FAR_TAIL_START, resolveHandicap, TAIL_START } from "./decision";
import type {
  CalibrationState,
  Confidence,
  GamePrediction,
} from "./decision";
import {
  expectedProfit,
  oppositeParts,
  settleParts,
} from "./handicap-notation";

export interface GameResult {
  homeScore: number;
  awayScore: number;
}

export interface SettledGame {
  gamePk: number;
  home: string;
  away: string;
  pass: boolean;
  /**
   * The pick's confidence band, kept so the cumulative report can answer
   * "does S actually outperform B?" — the question the 2026-08 audit had to
   * reconstruct by re-settling every prediction file. Optional because
   * history written before this field existed lacks it.
   */
  confidence?: Confidence | null;
  predictedWinner: string | null;
  /** null when the final score was level — nobody won. */
  actualWinner: string | null;
  /** null for PASS, and null for a level score (the moneyline pushes). */
  winnerCorrect: boolean | null;
  statedProbability: number | null;
  brier: number | null;
  handicapPick: string | null;
  handicapCorrect: boolean | null;
  /**
   * Realized profit per unit staked, after the house's cut. A 半 line can
   * settle between −1 and +0.9, so this — not the win/loss column — is what
   * the bet was actually worth.
   */
  handicapProfit: number | null;
  /** Stated probability that the handicap pick covers (for learning). */
  handicapProbability: number | null;
  /**
   * True when the settled handicap stake sat on a REAL (non-zero) line —
   * the A-2 audit's tripwire. The 半-line settlement machinery (split
   * stakes, partial pushes) was unproven in production until these existed,
   * so the daily settled report calls each one out for a hand-check against
   * the book's own statement. Optional: history rows from before the field
   * existed lack it, and a game with no handicap stake carries null.
   */
  handicapRealLine?: boolean | null;
  totalPick: "OVER" | "UNDER" | null;
  totalCorrect: boolean | null;
  /** Stated probability for the total pick (for learning). */
  totalProbability: number | null;
  /**
   * Whether each scored bet belonged to the TAIL band (raw probability ≥
   * TAIL_START), stamped AT SETTLE TIME from the prediction's own raw
   * probability. Banding at learn time by inverting the current calibration
   * map would misfile near-boundary bets whenever the core shrink has
   * drifted since the pick was made — recalibrateFromHistory replays years
   * of picks under the latest state, so it drifts every run. Optional
   * because history written before these fields lacks them; learning then
   * falls back to the boundary heuristic.
   */
  winnerTail?: boolean | null;
  handicapTail?: boolean | null;
  totalTail?: boolean | null;
  /**
   * Whether each scored bet belonged to the FAR-tail band (raw probability ≥
   * FAR_TAIL_START), stamped the same way. Rows written before the far-tail
   * split lack these; learning then splits the tail by the stated-space
   * boundary heuristic.
   */
  winnerFarTail?: boolean | null;
  handicapFarTail?: boolean | null;
  totalFarTail?: boolean | null;
  marginError: number | null; // |predicted margin − actual margin|
  totalError: number | null; // |predicted total − actual total|
}

export interface SettlementReport {
  date: string;
  gamesSettled: number;
  gamesPassed: number;
  gamesMissingResults: number;
  winnerRecord: { wins: number; losses: number };
  handicapRecord: { wins: number; losses: number };
  /**
   * The day's handicap P&L in units staked, after commission. `null` when no
   * handicap was settled. This is the number that decides whether the tool is
   * working: a winning record can still lose money once 10% comes off every
   * winner and 半 lines pay part stakes.
   */
  handicapProfit: number | null;
  totalRecord: { wins: number; losses: number };
  meanBrier: number | null;
  statedVsActual: { statedMean: number; actualRate: number } | null;
  meanMarginError: number | null;
  meanTotalError: number | null;
  games: SettledGame[];
  calibrationBefore: CalibrationState;
  calibrationAfter: CalibrationState;
}

/** Learning-rate and bounds for the core-band shrink update. */
const LEARN_RATE = 0.25;
const SHRINK_MIN = 0.5;
const SHRINK_MAX = 1.0;
/**
 * The tail band learns faster and may shrink further. Tail bets are scarce
 * (roughly a fifth of the book), so at the core's rate the damping term would
 * all but freeze them; and the failure the tail guards against — quoting 66%
 * and hitting 42% — is the expensive one, worth a stronger correction per
 * observed bet. Still damped and clamped: one bad slate cannot crater it.
 */
const TAIL_LEARN_RATE = 0.5;
const TAIL_SHRINK_MIN = 0.35;

/** One scored bet: what we said would happen, and whether it did. */
interface MarketSample {
  stated: number;
  correct: boolean;
  /** Settle-time band stamps; null/undefined for pre-stamp history. */
  tail?: boolean | null;
  farTail?: boolean | null;
}

/**
 * Move one band's shrink toward reality.
 *
 * Overconfident (we said 60%, we hit 50%) lowers the shrink so future edges
 * are quoted closer to 50%; underconfident raises it. Damped by sample size so
 * a single slate never swings the state, and clamped so it can never collapse
 * to "always 50%" or run away past "trust the raw model".
 */
function learnBand(
  current: number,
  samples: MarketSample[],
  learnRate: number,
  min: number,
): number {
  if (samples.length === 0) return current;
  const statedMean =
    samples.reduce((acc, s) => acc + s.stated, 0) / samples.length;
  const actualRate = samples.filter((s) => s.correct).length / samples.length;
  const gap = actualRate - statedMean;
  const damping = samples.length / (samples.length + 20);
  return (
    Math.round(clamp(current + learnRate * gap * damping, min, SHRINK_MAX) * 1000) /
    1000
  );
}

/**
 * Split one market's samples at the tail boundary and learn each band from
 * its own bets only. Learning the core from tail bets is precisely the
 * cross-contamination that let a single linear shrink stay wrong in both
 * directions at once.
 *
 * The band of record is the SETTLE-TIME STAMP (raw probability vs
 * TAIL_START, see SettledGame.winnerTail) — the raw probability is frozen in
 * the prediction lock, so the stamp cannot drift. Pre-stamp history falls
 * back to the boundary in stated space, 0.5 + (TAIL_START − 0.5) ·
 * coreShrink; that inversion uses the CURRENT core shrink where the stamp
 * would have used the prediction-time one, so a near-boundary legacy bet can
 * land in the wrong band — acceptable for old rows, which is why new rows
 * are stamped instead.
 */
function learnMarket(
  core: number,
  tail: number,
  farTail: number,
  samples: MarketSample[],
): { core: number; tail: number; farTail: number } {
  const boundary = 0.5 + (TAIL_START - 0.5) * core;
  const isTail = (s: MarketSample) =>
    s.tail == null ? s.stated >= boundary : s.tail;
  const tailSamples = samples.filter(isTail);
  // Only a settle-time FAR stamp can split the tail. A legacy row (no far
  // stamp) was quoted under the single-tail regime and its stated value
  // cannot recover which side of FAR_TAIL_START its raw probability sat on —
  // the stated space compresses as shrinks fall, so a fixed stated boundary
  // files the later, most-compressed (and worst) far-tail bets into the near
  // band. Legacy tail bets therefore teach BOTH tail bands, which reproduces
  // the exact single-tail state they were learned into before the split;
  // stamped rows, whose band is frozen at settle time, learn their own band
  // only.
  const nearOrLegacy = tailSamples.filter((s) => s.farTail !== true);
  const farOrLegacy = tailSamples.filter((s) => s.farTail !== false);
  const learnedTail = learnBand(
    tail,
    nearOrLegacy,
    TAIL_LEARN_RATE,
    TAIL_SHRINK_MIN,
  );
  const learnedFar = learnBand(
    farTail,
    farOrLegacy,
    TAIL_LEARN_RATE,
    TAIL_SHRINK_MIN,
  );
  return {
    core: learnBand(core, samples.filter((s) => !isTail(s)), LEARN_RATE, SHRINK_MIN),
    tail: learnedTail,
    // Monotone trust: confidence must not RISE with distance from 50%. The
    // record has never supported quoting the far tail more boldly than the
    // near tail, so the far band is capped at the near band's level.
    farTail: Math.min(learnedFar, learnedTail),
  };
}

/** Every market learns from its OWN scored bets, independently. */
export function updateCalibration(
  state: CalibrationState,
  settled: SettledGame[],
  now: Date,
): CalibrationState {
  const winner: MarketSample[] = [];
  const handicap: MarketSample[] = [];
  const total: MarketSample[] = [];
  let brierSum = 0;

  for (const s of settled) {
    if (s.winnerCorrect !== null && s.statedProbability !== null) {
      winner.push({
        stated: s.statedProbability,
        correct: s.winnerCorrect,
        tail: s.winnerTail,
        farTail: s.winnerFarTail,
      });
      brierSum += s.brier ?? 0;
    }
    if (s.handicapCorrect !== null && s.handicapProbability !== null) {
      handicap.push({
        stated: s.handicapProbability,
        correct: s.handicapCorrect,
        tail: s.handicapTail,
        farTail: s.handicapFarTail,
      });
    }
    if (s.totalCorrect !== null && s.totalProbability !== null) {
      total.push({
        stated: s.totalProbability,
        correct: s.totalCorrect,
        tail: s.totalTail,
        farTail: s.totalFarTail,
      });
    }
  }

  if (winner.length === 0 && handicap.length === 0 && total.length === 0) {
    return state;
  }

  const w = learnMarket(
    state.shrink,
    state.tailShrink,
    state.farTailShrink,
    winner,
  );
  const h = learnMarket(
    state.handicapShrink,
    state.handicapTailShrink,
    state.handicapFarTailShrink,
    handicap,
  );
  const t = learnMarket(
    state.totalShrink,
    state.totalTailShrink,
    state.totalFarTailShrink,
    total,
  );

  return {
    shrink: w.core,
    tailShrink: w.tail,
    farTailShrink: w.farTail,
    handicapShrink: h.core,
    handicapTailShrink: h.tail,
    handicapFarTailShrink: h.farTail,
    totalShrink: t.core,
    totalTailShrink: t.tail,
    totalFarTailShrink: t.farTail,
    gamesSettled: state.gamesSettled + winner.length,
    brierSum: Math.round((state.brierSum + brierSum) * 10000) / 10000,
    updatedAt: now.toISOString(),
  };
}

/**
 * Recompute the calibration state from the WHOLE settlement history.
 *
 * Settling is not a one-shot event: a slate gets settled once when the early
 * games finish and again later to pick up west-coast stragglers. Applying
 * `updateCalibration` incrementally on every run would learn from the same
 * games twice. Folding the full history instead — one report per date, oldest
 * first — makes settlement idempotent and lets a corrected re-settle actually
 * correct the learned state rather than compound it.
 */
export function recalibrateFromHistory(
  reports: SettlementReport[],
  base: CalibrationState,
  now: Date,
): CalibrationState {
  const byDate = new Map<string, SettlementReport>();
  for (const r of reports) byDate.set(r.date, r);
  const chronological = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  let state: CalibrationState = {
    ...base,
    gamesSettled: 0,
    brierSum: 0,
    updatedAt: null,
  };
  for (const r of chronological) {
    state = updateCalibration(state, r.games, now);
  }
  return state;
}

export function settle(
  date: string,
  predictions: GamePrediction[],
  results: Record<string, GameResult>,
  calibration: CalibrationState,
  now: Date,
): SettlementReport {
  const games: SettledGame[] = [];
  let missing = 0;

  for (const p of predictions) {
    const r = results[String(p.gamePk)];
    if (!r) {
      missing++;
      continue;
    }
    // MLB plays extras, so a level final score should not occur — but a
    // suspended game, a corrected box score or a feed glitch can still deliver
    // one, and `home > away ? home : away` would quietly call that an AWAY
    // WIN: a fabricated result, counted against the record and fed to the
    // calibrator as evidence the model was wrong. Treat it as the push it is.
    const tied = r.homeScore === r.awayScore;
    const actualWinner = tied
      ? null
      : r.homeScore > r.awayScore
        ? p.home
        : p.away;
    const actualMargin = r.homeScore - r.awayScore; // home perspective
    const actualTotal = r.homeScore + r.awayScore;
    const predictedMargin = p.expectedRuns.home - p.expectedRuns.away;

    let winnerCorrect: boolean | null = null;
    let brier: number | null = null;
    if (!p.pass && p.predictedWinner && !tied) {
      winnerCorrect = p.predictedWinner === actualWinner;
      const outcome = winnerCorrect ? 1 : 0;
      brier = (p.winProbability - outcome) ** 2;
    }

    let handicapCorrect: boolean | null = null;
    let handicapProfit: number | null = null;
    let handicapRealLine: boolean | null = null;
    // Gated on the PICK, not on `pass`. The handicap survives a thin-winner-
    // edge pass (decision.ts), so `pass` no longer answers "was a run-line
    // stake placed?" — the presence of a pick does, and it already carries
    // every gate that produced it. On history written before the markets were
    // decoupled a passed game never had a pick, so this scores identically.
    if (p.handicap.pick && p.handicap.input) {
      // Re-settle the exact basket of lines that was priced, against the score
      // that happened. A whole-number line landing on the margin PUSHES — the
      // stake comes back, so it is neither a win nor a loss and must not be
      // scored (scoring it as a loss would both misstate the record and teach
      // the calibrator from an outcome that never happened). A 半 line pushes
      // only PART of the stake, which is why this settles shares rather than a
      // yes/no: 〈1半2〉 winning by two runs is +8分, not a win and not a loss.
      const r = resolveHandicap(p.handicap.input);
      const quotedSideMargin =
        p.handicap.input.side === "home" ? actualMargin : -actualMargin;
      const pickedQuotedSide = p.handicap.pick.startsWith(
        p.handicap.input.side === "home" ? p.home : p.away,
      );
      const settled = settleParts(
        pickedQuotedSide ? r.parts : oppositeParts(r.parts),
        pickedQuotedSide ? quotedSideMargin : -quotedSideMargin,
      );
      // The record counts which way the stake mostly went; the money is
      // carried separately, because "8分勝ち" is a win that is not worth 1.
      handicapCorrect =
        settled.win === settled.loss ? null : settled.win > settled.loss;
      handicapProfit = round3(expectedProfit(settled));
      // A pick'em (every part on 0) is the moneyline in disguise; anything
      // else is the 半-line machinery earning its keep for real.
      handicapRealLine = !r.parts.every((part) => part.line === 0);
    }

    let totalCorrect: boolean | null = null;
    if (
      !p.pass &&
      p.total.pick &&
      p.total.line !== null &&
      actualTotal !== p.total.line
    ) {
      totalCorrect =
        p.total.pick === "OVER"
          ? actualTotal > p.total.line
          : actualTotal < p.total.line;
    }

    games.push({
      gamePk: p.gamePk,
      home: p.home,
      away: p.away,
      pass: p.pass,
      // A handicap-only bet still belongs to a confidence band: it is real
      // money, and `byConfidence` is the only breakdown that attributes it.
      // Without this the P&L of every decoupled handicap would vanish from
      // the band rows while still counting in the total.
      confidence: p.pass && !p.handicap.pick ? null : p.confidence,
      predictedWinner: p.predictedWinner,
      actualWinner,
      winnerCorrect,
      statedProbability: p.pass ? null : p.winProbability,
      brier: brier === null ? null : Math.round(brier * 10000) / 10000,
      handicapPick: p.handicap.pick,
      handicapCorrect,
      handicapProfit,
      handicapProbability: p.handicap.coverProbability,
      handicapRealLine,
      totalPick: p.total.pick,
      totalCorrect,
      totalProbability: p.total.probability,
      // Band stamps from the lock's own raw probabilities (see the field
      // docs). Predictions from before the raw fields existed yield null,
      // which learning treats as "band unknown — use the fallback".
      winnerTail:
        p.pass || tied ? null : p.rawWinProbability >= TAIL_START,
      handicapTail:
        handicapCorrect === null
          ? null
          : (p.handicap.rawCoverProbability ?? null) === null
            ? null
            : p.handicap.rawCoverProbability! >= TAIL_START,
      totalTail:
        totalCorrect === null
          ? null
          : (p.total.rawProbability ?? null) === null
            ? null
            : p.total.rawProbability! >= TAIL_START,
      winnerFarTail:
        p.pass || tied ? null : p.rawWinProbability >= FAR_TAIL_START,
      handicapFarTail:
        handicapCorrect === null
          ? null
          : (p.handicap.rawCoverProbability ?? null) === null
            ? null
            : p.handicap.rawCoverProbability! >= FAR_TAIL_START,
      totalFarTail:
        totalCorrect === null
          ? null
          : (p.total.rawProbability ?? null) === null
            ? null
            : p.total.rawProbability! >= FAR_TAIL_START,
      marginError: p.pass
        ? null
        : Math.round(Math.abs(predictedMargin - actualMargin) * 100) / 100,
      totalError: p.pass
        ? null
        : Math.round(Math.abs(p.total.predicted - actualTotal) * 100) / 100,
    });
  }

  const scored = games.filter((g) => g.winnerCorrect !== null);
  const record = (xs: (boolean | null)[]) => ({
    wins: xs.filter((x) => x === true).length,
    losses: xs.filter((x) => x === false).length,
  });

  const calibrationAfter = updateCalibration(calibration, games, now);

  return {
    date,
    gamesSettled: scored.length,
    gamesPassed: games.filter((g) => g.pass).length,
    gamesMissingResults: missing,
    winnerRecord: record(games.map((g) => g.winnerCorrect)),
    handicapRecord: record(games.map((g) => g.handicapCorrect)),
    handicapProfit: sumProfit(games),
    totalRecord: record(games.map((g) => g.totalCorrect)),
    meanBrier: mean(scored.map((g) => g.brier ?? 0)),
    statedVsActual:
      scored.length === 0
        ? null
        : {
            statedMean: round3(
              mean(scored.map((g) => g.statedProbability ?? 0))!,
            ),
            actualRate: round3(
              scored.filter((g) => g.winnerCorrect).length / scored.length,
            ),
          },
    meanMarginError: mean(
      games.filter((g) => g.marginError !== null).map((g) => g.marginError!),
    ),
    meanTotalError: mean(
      games.filter((g) => g.totalError !== null).map((g) => g.totalError!),
    ),
    games,
    calibrationBefore: calibration,
    calibrationAfter,
  };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const mean = (xs: number[]): number | null =>
  xs.length === 0
    ? null
    : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Total handicap P&L in units, or null when nothing was settled. */
function sumProfit(games: SettledGame[]): number | null {
  const settled = games.filter((g) => g.handicapProfit !== null);
  if (settled.length === 0) return null;
  return round3(settled.reduce((a, g) => a + g.handicapProfit!, 0));
}
