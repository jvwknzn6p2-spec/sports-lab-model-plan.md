/**
 * Stage 4 — Decision Engine.
 *
 * Turns a probability into an actual, human-readable pick: winner, loser,
 * handicap side, provisional confidence, and — crucially — a PASS when the game
 * is too close to call or the handicap edge is thin. Reasons are attached so the
 * daily output explains itself.
 */
import { COVER_GIVEN_WIN } from "./prediction.js";
import {
  decisionSchema,
  type Confidence,
  type ControlTower,
  type Decision,
  type IntakeGame,
  type Prediction,
} from "../schemas.js";

function confidenceFromEdge(edge: number, agreement: number): Confidence {
  if (edge >= 0.12 && agreement >= 0.75) return "S";
  if (edge >= 0.08 && agreement >= 0.65) return "A";
  if (edge >= 0.04) return "B";
  return "C";
}

export function decide(
  game: IntakeGame,
  pred: Prediction,
  ctrl: ControlTower,
): Decision {
  const p = pred.homeWinProbRaw;
  const homeIsWinner = p >= 0.5;
  const winnerAbbr = homeIsWinner ? game.home.abbreviation : game.away.abbreviation;
  const loserAbbr = homeIsWinner ? game.away.abbreviation : game.home.abbreviation;
  const winProbability = Math.max(p, 1 - p);
  const edge = Math.abs(p - 0.5);

  // Favorite cover probability (favorite covers their handicap).
  const favoriteIsHome = game.handicap.favorite === "home";
  const coverProbability = favoriteIsHome
    ? pred.coversProbRaw
    : (1 - p) * COVER_GIVEN_WIN;

  const reasons: string[] = [];
  reasons.push(
    `Model ${(p * 100).toFixed(0)}% home (logistic ${(pred.logisticP * 100).toFixed(0)}%, baseline ${(pred.baselineP * 100).toFixed(0)}%).`,
  );
  reasons.push(`Component agreement ${(pred.componentAgreement * 100).toFixed(0)}%.`);
  if (game.dataIssues.length) reasons.push(`Data issues: ${game.dataIssues.join("; ")}.`);

  // Winner PASS when the game is near a coin flip.
  let play = edge >= ctrl.thresholds.winPassBand;
  let passReason: string | null = play ? null : "winner too close to call (uncertain)";

  // Handicap pick.
  const favAbbr = favoriteIsHome ? game.home.abbreviation : game.away.abbreviation;
  const dogAbbr = favoriteIsHome ? game.away.abbreviation : game.home.abbreviation;
  const h = Math.abs(game.handicap.handicap);
  let handicapPick: string | null = null;
  let handicapSide: "favorite" | "underdog" | null = null;
  if (coverProbability >= ctrl.thresholds.handicapMinProb) {
    handicapPick = `${favAbbr} -${h}`;
    handicapSide = "favorite";
    reasons.push(`Favorite covers -${h} with ${(coverProbability * 100).toFixed(0)}%.`);
  } else if (coverProbability <= 1 - ctrl.thresholds.handicapMinProb) {
    handicapPick = `${dogAbbr} +${h}`;
    handicapSide = "underdog";
    reasons.push(`Underdog +${h} favored (favorite cover only ${(coverProbability * 100).toFixed(0)}%).`);
  } else {
    reasons.push(`No handicap edge (favorite cover ${(coverProbability * 100).toFixed(0)}%).`);
  }

  const provisionalConfidence = confidenceFromEdge(edge, pred.componentAgreement);

  return decisionSchema.parse({
    gameId: game.gameId,
    winner: play ? winnerAbbr : null,
    loser: play ? loserAbbr : null,
    handicapPick,
    handicapSide,
    winProbability,
    coverProbability,
    provisionalConfidence,
    play,
    passReason,
    reasons,
  });
}
