/**
 * Expected value — the question the whole pipeline exists to answer.
 *
 * Everything upstream answers "who wins?". That is not the same as "is this
 * bet worth making?", and the gap between them is the house's cut. A winner
 * receives 90% of the nominal amount, so a coin-flip you win 52% of the time
 * still loses money over a season. The break-even point is
 *
 *     p(1 − c) = (1 − p)   →   p = 1 / (2 − c)
 *
 * which at c = 0.1 is **52.63%**, not 50%. Any pick quoted between 50% and
 * 52.6% is a losing bet stated as a winning one.
 *
 * ## Why this is computed from stake SHARES, not a probability alone
 *
 * A handicap does not settle as win-or-lose. A whole line returns the stake on
 * the exact margin, and the 半 family splits the stake so part of it can win
 * while the rest pushes (see handicap-notation.ts). The returned share is
 * neither won nor lost, so it must be excluded from the risk as well as from
 * the reward — treating a push as a loss overstates the cost of a line, and
 * treating it as a win overstates the edge.
 */

import { expectedProfit, WIN_COMMISSION } from "./handicap-notation";

/**
 * Profit per unit staked, rebuilt from a CALIBRATED cover probability.
 *
 * `decide` shrinks the raw simulation probability toward 50% by what the
 * settled record has taught it, so the EV that reaches the user has to be
 * built from the shrunk number rather than the raw one — otherwise the
 * self-learning corrects the quoted probability while leaving the bet
 * recommendation as over-confident as it ever was.
 *
 * `pushShare` is carried through untouched: calibration is a statement about
 * how well the model separates winners from losers, not about how often the
 * scoreline lands exactly on the line.
 */
export function expectedValueFromProbability(
  probability: number,
  pushShare: number,
  commission = WIN_COMMISSION,
): number {
  const atRisk = 1 - pushShare;
  return expectedProfit(
    {
      win: atRisk * probability,
      push: pushShare,
      loss: atRisk * (1 - probability),
    },
    commission,
  );
}

/**
 * The probability a bet must clear to break even at this commission.
 * 52.63% at the standard 10% cut — emphatically not 50%.
 */
export function breakEvenProbability(commission = WIN_COMMISSION): number {
  return 1 / (2 - commission);
}
