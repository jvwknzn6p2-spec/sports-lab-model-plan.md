/**
 * Pricing any market from a simulated score distribution.
 *
 * Everything here is a deterministic read over the joint matrix produced by
 * `simulateGame` — no extra randomness, no re-simulation. Ask for a −1.5 run
 * line, a −0.75 Asian handicap and four different totals off the same
 * distribution and they will all be mutually consistent, because they are all
 * views of the same 10,000 simulated games.
 */

import { decimalToAmerican } from "./odds.ts";
import type { MarketPrice, ScoreDistribution, Side } from "./types.ts";

export type TotalDirection = "over" | "under";

/** Lines are quoted in quarter-run steps; anything finer is a mistake upstream. */
function assertQuotableLine(line: number, label: string): void {
  if (!Number.isFinite(line) || Math.abs(line * 4 - Math.round(line * 4)) > 1e-9) {
    throw new RangeError(`${label} must be a multiple of 0.25, got ${line}`);
  }
}

/** True for quarter lines (−0.75, +0.25, 8.75 …), which are settled as two half-stakes. */
function isSplitLine(line: number): boolean {
  return Math.abs(line * 2 - Math.round(line * 2)) > 1e-9;
}

function makePrice(win: number, push: number, sims: number): MarketPrice {
  const loss = Math.max(0, 1 - win - push);
  // Stake back on a push, so break-even odds solve win x (O − 1) = loss.
  const fairDecimal = win > 0 ? 1 + loss / win : Infinity;
  return {
    win,
    push,
    loss,
    fairDecimal,
    fairAmerican: decimalToAmerican(fairDecimal),
    standardError: Math.sqrt((win * (1 - win)) / sims),
    sims,
  };
}

/** Averages the two half-lines a quarter line splits into. */
function blend(a: MarketPrice, b: MarketPrice, sims: number): MarketPrice {
  return makePrice((a.win + b.win) / 2, (a.push + b.push) / 2, sims);
}

/**
 * Probability mass over the margin `home − away`.
 *
 * Returned as a dense array plus the margin its index 0 corresponds to, which
 * is friendlier to iterate than a map and small enough not to matter.
 */
export function marginDistribution(dist: ScoreDistribution): {
  offset: number;
  probabilities: Float64Array;
} {
  const max = dist.stride - 1;
  const probabilities = new Float64Array(2 * max + 1);
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) {
      const count = dist.joint[home * dist.stride + away];
      if (count !== 0) probabilities[home - away + max] += count / dist.sims;
    }
  }
  return { offset: -max, probabilities };
}

/** Probability mass over combined runs. Index is the total itself. */
export function totalDistribution(dist: ScoreDistribution): Float64Array {
  const max = dist.stride - 1;
  const probabilities = new Float64Array(2 * max + 1);
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) {
      const count = dist.joint[home * dist.stride + away];
      if (count !== 0) probabilities[home + away] += count / dist.sims;
    }
  }
  return probabilities;
}

/** Straight-up win probability, priced as a market. Ties do not survive the simulator. */
export function priceMoneyline(dist: ScoreDistribution, side: Side): MarketPrice {
  const max = dist.stride - 1;
  let wins = 0;
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) {
      const count = dist.joint[home * dist.stride + away];
      if (count === 0) continue;
      const homeWon = home > away;
      if (side === "home" ? homeWon : !homeWon) wins += count;
    }
  }
  return makePrice(wins / dist.sims, 0, dist.sims);
}

function priceHalfHandicap(dist: ScoreDistribution, side: Side, line: number): MarketPrice {
  const max = dist.stride - 1;
  let wins = 0;
  let pushes = 0;
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) {
      const count = dist.joint[home * dist.stride + away];
      if (count === 0) continue;
      const margin = side === "home" ? home - away : away - home;
      const adjusted = margin + line;
      if (adjusted > 0) wins += count;
      else if (adjusted === 0) pushes += count;
    }
  }
  return makePrice(wins / dist.sims, pushes / dist.sims, dist.sims);
}

/**
 * Price a handicap of any size for either side.
 *
 * `line` is added to that side's margin, so MLB's standard run line is
 * `priceHandicap(dist, "home", -1.5)`. Integer lines can push; quarter lines
 * are settled as two half-stakes and reported blended.
 */
export function priceHandicap(dist: ScoreDistribution, side: Side, line: number): MarketPrice {
  assertQuotableLine(line, "handicap line");
  if (!isSplitLine(line)) return priceHalfHandicap(dist, side, line);
  return blend(
    priceHalfHandicap(dist, side, line - 0.25),
    priceHalfHandicap(dist, side, line + 0.25),
    dist.sims,
  );
}

function priceHalfTotal(
  dist: ScoreDistribution,
  direction: TotalDirection,
  line: number,
): MarketPrice {
  const totals = totalDistribution(dist);
  let win = 0;
  let push = 0;
  for (let total = 0; total < totals.length; total++) {
    const probability = totals[total];
    if (probability === 0) continue;
    const difference = total - line;
    if (difference === 0) push += probability;
    else if (direction === "over" ? difference > 0 : difference < 0) win += probability;
  }
  return makePrice(win, push, dist.sims);
}

/** Price over/under at any line, including integer lines (which can push) and quarter lines. */
export function priceTotal(
  dist: ScoreDistribution,
  direction: TotalDirection,
  line: number,
): MarketPrice {
  assertQuotableLine(line, "total line");
  if (!isSplitLine(line)) return priceHalfTotal(dist, direction, line);
  return blend(
    priceHalfTotal(dist, direction, line - 0.25),
    priceHalfTotal(dist, direction, line + 0.25),
    dist.sims,
  );
}

/** Expected combined runs — the number to compare against the posted total. */
export function expectedTotal(dist: ScoreDistribution): number {
  return dist.meanRuns.home + dist.meanRuns.away;
}

/** Expected margin from the home team's perspective. */
export function expectedMargin(dist: ScoreDistribution): number {
  return dist.meanRuns.home - dist.meanRuns.away;
}

/**
 * The most likely exact scores, descending.
 *
 * Useful on the prediction card: "8.7 expected runs" is abstract, whereas
 * "5–3 is the single most likely scoreline at 4.1%" is the kind of thing a
 * reader can sanity-check against their own intuition.
 */
export function likeliestScores(
  dist: ScoreDistribution,
  count = 5,
): Array<{ home: number; away: number; probability: number }> {
  const max = dist.stride - 1;
  const scores: Array<{ home: number; away: number; probability: number }> = [];
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) {
      const n = dist.joint[home * dist.stride + away];
      if (n !== 0) scores.push({ home, away, probability: n / dist.sims });
    }
  }
  scores.sort((a, b) => b.probability - a.probability);
  return scores.slice(0, count);
}
