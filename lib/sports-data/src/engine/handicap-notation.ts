/**
 * The Japanese handicap notation this project actually bets into.
 *
 * Two families:
 *
 *   PLAIN — `0`, `0.1` … `0.9`, `1.0`, `1.1` … `1.9`
 *     A literal run handicap. Settles the ordinary way: the backed side wins
 *     when margin − line > 0, pushes when it lands exactly on a whole number,
 *     and loses otherwise. `0` is "なし" — no handicap at all.
 *
 *   HALF — `1半`, `1半1` … `1半9` (and the same shape at any whole number)
 *     "半" marks the 特殊計算. The headline line is N.5, but the digit after
 *     半 scales what a win by exactly N+1 pays:
 *
 *       1半    draw / 1-run → full loss, 2-run → FULL win
 *       1半1   draw / 1-run → full loss, 2-run → 9分 (90%), 3-run → full win
 *       1半9   …                          2-run → 1分 (10%)
 *       1半X   …                          2-run → (10 − X) × 10%
 *
 * The payout ladder is not a special case — it is exactly a SPLIT STAKE:
 *
 *     N半X  ==  (10 − X)/10 of the stake on N.5  +  X/10 on N+1
 *
 * Check it against `1半1` (0.9 on 1.5, 0.1 on 2.0):
 *   margin ≤ 1 → both lose            → −1.0   (まる負け)
 *   margin = 2 → 1.5 wins, 2.0 PUSHES → +0.9   (9分勝ち)
 *   margin ≥ 3 → both win             → +1.0   (まるかち)
 *
 * …which is the ladder exactly. `1半9` gives +0.1 at two runs (1分勝ち), and
 * `1半` (X = 0) puts the whole stake on 1.5, so two runs pays in full. The
 * "special" calculation is therefore the ordinary calculation applied to a
 * weighted pair of lines, and every push rule already implemented carries over
 * unchanged.
 *
 * Winnings then take the house's cut: a winner receives 90% of the nominal
 * amount. `1半2` winning by two runs pays (10−2)/10 = 8分 → +8 on a 10 stake
 * → less 10% → **+7.2**, which is the worked example this was derived from.
 */

/** One component of a handicap: a line carrying part of the stake. */
export interface WeightedLine {
  line: number;
  /** Share of the stake on this line. Weights sum to 1. */
  weight: number;
}

export interface ParsedHandicap {
  /** The notation as written, normalized. */
  notation: string;
  parts: WeightedLine[];
  /** Stake-weighted line, for display and ordering. */
  effectiveLine: number;
  /** True for the 半 family (特殊計算). */
  special: boolean;
}

/** The house's cut on a winning bet: winners receive 90% of the nominal win. */
export const WIN_COMMISSION = 0.1;

export class HandicapNotationError extends Error {
  constructor(input: string, why: string) {
    super(`Cannot read handicap "${input}": ${why}`);
    this.name = "HandicapNotationError";
  }
}

/** Full-width digits and brackets are common in pasted slates. */
function normalize(input: string): string {
  return input
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".")
    .replace(/^[〈<＜]|[〉>＞]$/g, "")
    .trim();
}

/**
 * Parse a handicap into the weighted lines it settles as.
 *
 * Unknown notation throws rather than guessing: mis-reading a line silently
 * flips which side a bet is on, which is the one error this pipeline must
 * never make quietly.
 */
export function parseHandicapNotation(input: string): ParsedHandicap {
  const s = normalize(input);
  if (s === "") throw new HandicapNotationError(input, "empty");
  if (s === "なし") return plain(0, "0");

  // N半X — the 特殊計算 family.
  const half = /^(\d+)半(\d)?$/.exec(s);
  if (half) {
    const whole = Number(half[1]);
    const digit = half[2] === undefined ? 0 : Number(half[2]);
    // X/10 of the stake rides the next whole line, which PUSHES at N+1.
    // Both weights come from integer tenths: deriving the second as
    // `1 - 0.9` would land on 0.09999999999999998 and drift through every
    // downstream payout.
    const parts: WeightedLine[] = [
      { line: whole + 0.5, weight: (10 - digit) / 10 },
    ];
    if (digit > 0) parts.push({ line: whole + 1, weight: digit / 10 });
    return {
      notation: s,
      parts,
      effectiveLine: parts.reduce((a, p) => a + p.line * p.weight, 0),
      special: true,
    };
  }

  // Plain decimal, one tenth at a time.
  const plainMatch = /^(\d+)(?:\.(\d))?$/.exec(s);
  if (plainMatch) {
    const value = Number(s);
    if (value > 20) {
      throw new HandicapNotationError(input, "implausibly large for baseball");
    }
    return plain(value, s);
  }

  throw new HandicapNotationError(
    input,
    "expected 0, a tenth like 0.7 / 1.4, or the 半 form like 1半 / 1半2",
  );
}

function plain(value: number, notation: string): ParsedHandicap {
  return {
    notation,
    parts: [{ line: value, weight: 1 }],
    effectiveLine: value,
    special: false,
  };
}

/**
 * Profit per unit staked, given how the stake settled.
 *
 * A push returns its share, so it contributes nothing either way; the winning
 * share is reduced by the house's cut.
 */
export function expectedProfit(
  settled: StakeOutcome,
  commission = WIN_COMMISSION,
): number {
  return settled.win * (1 - commission) - settled.loss;
}

/** How a stake came back: shares that won, pushed and lost. Sums to 1. */
export interface StakeOutcome {
  win: number;
  push: number;
  loss: number;
}

/**
 * Split a bare number into the sub-lines it is really made of.
 *
 * A quarter line (x.25 / x.75) is half a stake on each neighbouring half-line;
 * everything else carries the whole stake on one line. This is the same idea as
 * the 半 family — a handicap is a weighted basket of lines — which is why both
 * settle through the same code below.
 */
export function splitLine(line: number): WeightedLine[] {
  const quarter = Math.abs(line * 4 - Math.round(line * 4)) < 1e-9;
  const half = Math.abs(line * 2 - Math.round(line * 2)) < 1e-9;
  if (quarter && !half) {
    return [
      { line: line - 0.25, weight: 0.5 },
      { line: line + 0.25, weight: 0.5 },
    ];
  }
  return [{ line, weight: 1 }];
}

/**
 * Settle a basket of lines against one realized margin, from the perspective
 * of the side that holds them (its own margin, its own signed lines).
 *
 * This is THE settlement rule. The simulator runs it over ten thousand
 * imagined margins and the settler runs it over the one that happened, so a
 * 半 line cannot be quoted as a split stake and then scored as win-or-lose —
 * an inconsistency that would teach the calibrator from an outcome the market
 * never actually pays.
 */
export function settleParts(
  parts: readonly WeightedLine[],
  margin: number,
): StakeOutcome {
  let win = 0;
  let push = 0;
  let loss = 0;
  for (const part of parts) {
    const settled = margin + part.line;
    if (settled > 0) win += part.weight;
    else if (settled === 0) push += part.weight;
    else loss += part.weight;
  }
  return { win, push, loss };
}

/** Flip a basket of lines to the other side of the same handicap. */
export function oppositeParts(parts: readonly WeightedLine[]): WeightedLine[] {
  return parts.map((p) => ({ line: -p.line, weight: p.weight }));
}
