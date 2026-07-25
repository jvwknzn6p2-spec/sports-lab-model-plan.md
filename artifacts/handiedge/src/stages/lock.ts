/**
 * Stage 6 — Prediction Lock (with AI Review).
 *
 * Maps the calibrated decision onto the `@workspace/ai-review` contract, runs the
 * three-agent review, and enforces PASS when the reviewed confidence falls to or
 * below the Control Tower's threshold (this is how an unconfirmed starter or
 * stale data turns a pick into a PASS). The result is frozen into an immutable,
 * content-hashed `GameOutput`.
 */
import { reviewPrediction, rankIndex } from "@workspace/ai-review";
import type { GamePrediction, ReviewProvider, ConfidenceRank } from "@workspace/ai-review";
import { sha256 } from "../util/hash.js";
import {
  gameOutputSchema,
  type CalibratedDecision,
  type Confidence,
  type ControlTower,
  type GameOutput,
  type IntakeGame,
  type Prediction,
} from "../schemas.js";

function toReviewContract(
  game: IntakeGame,
  pred: Prediction,
  dec: CalibratedDecision,
): GamePrediction {
  const s = game.schedule;
  const p = dec.calibratedHomeWinProb;
  const weather =
    s.windDir != null && s.windMph != null
      ? {
          tempF: s.tempF ?? 72,
          windMph: s.windMph,
          windDir: s.windDir,
          precipitationChance: 0,
        }
      : null;

  return {
    gameId: game.gameId,
    startTimeLocal: game.startTimeLocal,
    home: game.home,
    away: game.away,
    data: {
      scheduleConfirmed: true,
      homePitcher: s.homePitcher,
      awayPitcher: s.awayPitcher,
      battingStatsAvailable: s.battingStatsAvailable,
      bullpenStatsAvailable: s.bullpenStatsAvailable,
      recentFormAvailable: true,
      injuries: [],
      weather,
      parkFactorsAvailable: true,
      oddsAvailable: s.oddsAvailable,
      fetchedAt: s.fetchedAt,
      staleAfterMinutes: 240,
    },
    model: {
      moneyline: { homeWinProb: p, awayWinProb: 1 - p },
      runLine: {
        favoriteCoversProb: dec.coverProbability,
        underdogCoversProb: 1 - dec.coverProbability,
      },
      total: {
        predictedTotal: pred.predictedTotal,
        line: Math.round(pred.predictedTotal * 2) / 2,
        overProb: 0.5,
        underProb: 0.5,
      },
      ev: { bets: [] },
      componentAgreement: pred.componentAgreement,
      marketEdge: Math.abs(p - 0.5),
    },
    confidence: dec.provisionalConfidence,
    keyFactors: dec.reasons,
  };
}

export interface LockContext {
  provider: ReviewProvider;
  now: Date;
}

export async function lockGame(
  game: IntakeGame,
  pred: Prediction,
  dec: CalibratedDecision,
  ctrl: ControlTower,
  ctx: LockContext,
): Promise<GameOutput> {
  const contract = toReviewContract(game, pred, dec);
  const review = await reviewPrediction(contract, { provider: ctx.provider, now: ctx.now });
  const finalConfidence = review.finalConfidence as Confidence;

  // Confidence-based PASS gate from the Control Tower.
  const passAtOrBelow = ctrl.thresholds.passAtOrBelow;
  const confidencePass =
    passAtOrBelow !== "none" &&
    rankIndex(finalConfidence) >= rankIndex(passAtOrBelow as ConfidenceRank);

  let winner: string | null = null;
  let loser: string | null = null;
  let handicapPick: string | null = null;
  let handicapSide: "favorite" | "underdog" | null = null;
  let decision: "PLAY" | "PASS";
  let passReason: string | null;

  if (confidencePass) {
    decision = "PASS";
    passReason = `AI review confidence ${finalConfidence}${
      review.warnings.length ? `: ${review.warnings[0]}` : ""
    }`;
  } else {
    winner = dec.play ? dec.winner : null;
    loser = dec.play ? dec.loser : null;
    handicapPick = dec.handicapPick;
    handicapSide = dec.handicapSide;
    const hasPlay = winner !== null || handicapPick !== null;
    decision = hasPlay ? "PLAY" : "PASS";
    passReason = hasPlay ? null : dec.passReason ?? "no actionable edge";
  }

  const reasons = [...dec.reasons, ...review.warnings];
  const core = {
    gameId: game.gameId,
    decision,
    winner,
    loser,
    handicapPick,
    winProbability: Number(dec.winProbability.toFixed(4)),
    confidence: finalConfidence,
  };

  return gameOutputSchema.parse({
    ...core,
    matchup: `${game.away.abbreviation} @ ${game.home.abbreviation}`,
    reasons,
    passReason,
    contentHash: sha256(core),
    homeAbbr: game.home.abbreviation,
    awayAbbr: game.away.abbreviation,
    homeWinProbHome: Number(dec.calibratedHomeWinProb.toFixed(4)),
    handicapFavorite: game.handicap.favorite,
    handicapLine: Math.abs(game.handicap.handicap),
    handicapSide,
  });
}
