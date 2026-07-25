/**
 * Step 6: expected value against the market.
 *
 * The one subtlety that separates a real EV number from a naive one is the vig.
 * A book's two prices imply probabilities that sum to more than 1 — that excess
 * is its margin. Comparing the model to the *raw* implied probability credits
 * the model with the book's built-in hold and manufactures edges that are not
 * there. So the implied probabilities are always de-vigged first.
 *
 * Two de-vig methods are provided. The proportional method divides by the
 * overround; it is fine for near-even markets but strips the same *relative*
 * margin from both sides, which is not how books price. Books load more margin
 * onto the longshot (the favourite-longshot bias), so the power method — solve
 * for the exponent k where sum(q_i^k) = 1 — is the default. On a -400/+320
 * market it removes about 2% from the favourite and about 10% from the dog,
 * which raises the favourite's fair probability relative to proportional and
 * makes the model's bar for backing a favourite correctly higher.
 */

import { MLB_CONSTANTS, type ModelConstants } from "../config";
import { clamp } from "../core/math";
import type {
  AmericanOdds,
  BetEvaluation,
  BetGrading,
  OddsSnapshot,
  SimulationResult,
  TeamRef,
} from "../core/types";
import { probAbove, probBelow, probEqual } from "./simulate";

export function americanToDecimal(odds: AmericanOdds): number {
  if (!Number.isFinite(odds) || Math.abs(odds) < 100) {
    throw new Error(`Invalid American odds: ${odds}`);
  }
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) throw new Error(`Invalid decimal odds: ${decimal}`);
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : -Math.round(100 / (decimal - 1));
}

export function impliedProbability(odds: AmericanOdds): number {
  return 1 / americanToDecimal(odds);
}

export type DevigMethod = "proportional" | "power";

/** Strip the bookmaker's margin from a set of implied probabilities. */
export function devig(
  implied: number[],
  method: DevigMethod = "power",
): number[] {
  const sum = implied.reduce((acc, p) => acc + p, 0);
  if (sum <= 0) return implied.map(() => 0);
  if (method === "proportional" || implied.length < 2) {
    return implied.map((p) => p / sum);
  }
  // Find the exponent that makes the probabilities sum to exactly 1. The book
  // is overround (sum > 1), so the exponent is above 1; bisect on it. Raising
  // every probability to k > 1 shrinks small probabilities far more in relative
  // terms than large ones, which is the favourite-longshot correction.
  const f = (exponent: number): number =>
    implied.reduce((acc, p) => acc + Math.pow(p, exponent), 0) - 1;
  let low = 1;
  let high = 8;
  if (f(low) < 0) return implied.map((p) => p / sum);
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (f(mid) > 0) low = mid;
    else high = mid;
  }
  const exponent = (low + high) / 2;
  const raw = implied.map((p) => Math.pow(p, exponent));
  const rawSum = raw.reduce((acc, p) => acc + p, 0);
  return rawSum > 0 ? raw.map((p) => p / rawSum) : implied.map((p) => p / sum);
}

export interface EvaluateBetInput {
  market: BetEvaluation["market"];
  selection: string;
  grading: BetGrading;
  americanOdds: AmericanOdds;
  modelProbability: number;
  fairProbability: number;
  minEdge: number;
  maxKelly: number;
}

export function evaluateBet(input: EvaluateBetInput): BetEvaluation {
  const decimalOdds = americanToDecimal(input.americanOdds);
  const p = clamp(input.modelProbability, 0, 1);
  const profitIfWin = decimalOdds - 1;
  const expectedValue = p * profitIfWin - (1 - p);
  const edge = p - input.fairProbability;
  const kellyRaw = profitIfWin > 0 ? (p * decimalOdds - 1) / profitIfWin : 0;
  const kellyFraction = clamp(kellyRaw, 0, input.maxKelly);
  return {
    market: input.market,
    selection: input.selection,
    grading: input.grading,
    americanOdds: input.americanOdds,
    decimalOdds,
    modelProbability: p,
    fairProbability: input.fairProbability,
    edge,
    expectedValue,
    kellyFraction,
    positiveEv: expectedValue > 0 && edge >= input.minEdge,
  };
}

export interface GameBetInputs {
  odds: OddsSnapshot | null;
  simulation: SimulationResult;
  /** Calibrated home win probability — the number we actually bet with. */
  homeWinProbability: number;
  home: TeamRef;
  away: TeamRef;
  /**
   * Calibrated predicted total minus the raw simulated mean. Applied by shifting
   * the line we read off the simulated distribution, so a learned totals bias
   * flows into the over/under probabilities instead of only into the displayed
   * number.
   */
  totalShift?: number;
  constants?: ModelConstants;
  devigMethod?: DevigMethod;
}

/**
 * Price every market the book offers for this game.
 *
 * Moneyline uses the calibrated win probability. Run line and total are read
 * off the simulated distributions, so any handicap or line the book posts can
 * be evaluated — including integer lines, where a push is possible and the
 * effective stake shrinks accordingly.
 */
export function evaluateGameBets(input: GameBetInputs): BetEvaluation[] {
  const constants = input.constants ?? MLB_CONSTANTS;
  const method = input.devigMethod ?? "power";
  const odds = input.odds;
  if (!odds) return [];
  const bets: BetEvaluation[] = [];
  const minEdge = constants.minEdgeForBet;
  const maxKelly = constants.maxKellyFraction;

  if (odds.moneyline) {
    const fair = devig(
      [impliedProbability(odds.moneyline.home), impliedProbability(odds.moneyline.away)],
      method,
    );
    const homeProb = clamp(input.homeWinProbability, 0, 1);
    bets.push(
      evaluateBet({
        market: "moneyline",
        selection: `${input.home.abbrev} ML`,
        grading: { kind: "moneyline", side: "home" },
        americanOdds: odds.moneyline.home,
        modelProbability: homeProb,
        fairProbability: fair[0] as number,
        minEdge,
        maxKelly,
      }),
      evaluateBet({
        market: "moneyline",
        selection: `${input.away.abbrev} ML`,
        grading: { kind: "moneyline", side: "away" },
        americanOdds: odds.moneyline.away,
        modelProbability: 1 - homeProb,
        fairProbability: fair[1] as number,
        minEdge,
        maxKelly,
      }),
    );
  }

  if (odds.runLine) {
    const handicap = odds.runLine.homeHandicap;
    const margin = input.simulation.marginHistogram;
    // Home covers when margin + handicap > 0; a push needs an integer handicap.
    const homePush = probEqual(margin, -handicap);
    const homeWinProb = probAbove(margin, -handicap);
    const awayWinProb = probBelow(margin, -handicap);
    const homeConditional = homePush < 1 ? homeWinProb / (1 - homePush) : 0;
    const awayConditional = homePush < 1 ? awayWinProb / (1 - homePush) : 0;
    const fair = devig(
      [impliedProbability(odds.runLine.home), impliedProbability(odds.runLine.away)],
      method,
    );
    const sign = handicap >= 0 ? "+" : "";
    bets.push(
      evaluateBet({
        market: "runline",
        selection: `${input.home.abbrev} ${sign}${handicap}`,
        grading: { kind: "runline", side: "home", homeHandicap: handicap },
        americanOdds: odds.runLine.home,
        modelProbability: homeConditional,
        fairProbability: fair[0] as number,
        minEdge,
        maxKelly,
      }),
      evaluateBet({
        market: "runline",
        selection: `${input.away.abbrev} ${handicap >= 0 ? "-" : "+"}${Math.abs(handicap)}`,
        grading: { kind: "runline", side: "away", homeHandicap: handicap },
        americanOdds: odds.runLine.away,
        modelProbability: awayConditional,
        fairProbability: fair[1] as number,
        minEdge,
        maxKelly,
      }),
    );
  }

  if (odds.total) {
    const totals = input.simulation.totalHistogram;
    const line = odds.total.line;
    const effectiveLine = line - (input.totalShift ?? 0);
    const pushProb = probEqual(totals, effectiveLine);
    const overRaw = probAbove(totals, effectiveLine);
    const underRaw = probBelow(totals, effectiveLine);
    const overConditional = pushProb < 1 ? overRaw / (1 - pushProb) : 0;
    const underConditional = pushProb < 1 ? underRaw / (1 - pushProb) : 0;
    const fair = devig(
      [impliedProbability(odds.total.over), impliedProbability(odds.total.under)],
      method,
    );
    bets.push(
      evaluateBet({
        market: "total",
        selection: `Over ${line}`,
        grading: { kind: "total", direction: "over", line },
        americanOdds: odds.total.over,
        modelProbability: overConditional,
        fairProbability: fair[0] as number,
        minEdge,
        maxKelly,
      }),
      evaluateBet({
        market: "total",
        selection: `Under ${line}`,
        grading: { kind: "total", direction: "under", line },
        americanOdds: odds.total.under,
        modelProbability: underConditional,
        fairProbability: fair[1] as number,
        minEdge,
        maxKelly,
      }),
    );
  }

  return bets;
}
