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

/**
 * Kelly fraction actually recommended. Full Kelly assumes the stated edge is
 * exact; this book's own record says its edges arrive with error (that is
 * what the whole calibration layer corrects), and overbetting a misjudged
 * edge costs more than underbetting a real one. A quarter is the
 * conventional, deliberately timid choice.
 */
export const KELLY_FRACTION = 0.25;
/** Never recommend more than one unit, however loud the edge. */
export const KELLY_STAKE_CAP = 1;

/**
 * Recommended stake in units for a bet with this per-unit EV, as a fraction
 * of the one-unit bankroll quantum the record is kept in. DISPLAY-ONLY
 * decision support: settlement still scores every pick at a flat 1 unit, so
 * the P&L record stays comparable across days and with its own history.
 *
 * Two-outcome Kelly at win payout b = 1 − commission is f* = EV / b. A 半
 * line's push share is already inside EV (a pushed share neither wins nor
 * loses), which makes this the at-risk-scaled Kelly — slightly conservative
 * for split-stake lines, which is the right direction to be wrong in.
 * Null when there is no bet to size; 0 when the bet is not worth staking.
 */
export function recommendedStake(
  ev: number | null,
  commission = WIN_COMMISSION,
): number | null {
  if (ev === null) return null;
  if (ev <= 0) return 0;
  const fullKelly = ev / (1 - commission);
  return Math.min(
    KELLY_STAKE_CAP,
    Math.round(fullKelly * KELLY_FRACTION * 100) / 100,
  );
}
