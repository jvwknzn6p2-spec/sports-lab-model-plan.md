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

import type { AsianCover } from "./simulate";
import { WIN_COMMISSION } from "./handicap-notation";

/**
 * Profit per unit staked. Positive means the bet makes money at this price
 * over the long run; zero is break-even; negative is a losing bet.
 */
export function expectedValue(
  cover: Pick<AsianCover, "win" | "push" | "loss">,
  commission = WIN_COMMISSION,
): number {
  return cover.win * (1 - commission) - cover.loss;
}

/**
 * The same figure, rebuilt from a CALIBRATED cover probability.
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
  const win = atRisk * probability;
  const loss = atRisk * (1 - probability);
  return win * (1 - commission) - loss;
}

/**
 * The probability a bet must clear to break even at this commission.
 * 52.63% at the standard 10% cut — emphatically not 50%.
 */
export function breakEvenProbability(commission = WIN_COMMISSION): number {
  return 1 / (2 - commission);
}

/** How far the model's probability sits above break-even, in points. */
export function edgeOverBreakEven(
  probability: number,
  commission = WIN_COMMISSION,
): number {
  return probability - breakEvenProbability(commission);
}

/**
 * Order picks by expected value, best first — the recommendation order.
 *
 * Sorting by win probability instead would promote a near-certain bet that
 * pays almost nothing over a genuinely profitable one, which is the mistake
 * this ordering exists to prevent.
 */
export function byExpectedValue<T extends { ev: number | null }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => (b.ev ?? -Infinity) - (a.ev ?? -Infinity));
}
