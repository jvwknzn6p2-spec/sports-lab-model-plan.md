/**
 * Step 6 — Expected value.
 *
 * Compares the simulation's probabilities against the sportsbook's prices and
 * decides whether a bet is worth making (plan Section 4.3).
 *
 * The arithmetic per 1 unit staked, where `d` is decimal odds:
 *
 *   EV = P(win) × (d − 1) − P(lose) × 1 + P(push) × 0
 *
 * Two probabilities are reported for every bet and they answer different
 * questions — conflating them is the classic way to invent an edge that
 * isn't there:
 *
 *   - **EV** uses the model's *unconditional* probabilities, because a push
 *     genuinely returns the stake and belongs in the expectation.
 *   - **Edge** compares the model against the de-vigged market *conditional on
 *     no push*, because that is what the book's two prices actually price.
 *     Comparing an unconditional model number against a conditional market
 *     number would overstate the edge on any market that can push.
 *
 * A positive edge is not automatically a bet: `minEdge` keeps marginal
 * disagreements — which are mostly model noise — from being flagged as value.
 */
import type { SimulationResult } from "../model/simulate";
import type { GameOdds } from "../schemas";
import { americanToDecimal, removeVigAmerican, type AmericanOdds } from "./conversion";

/** Which market a bet belongs to. */
export type BetMarket = "moneyline" | "run_line" | "total";

/** Which side of the market was priced. */
export type BetSelection = "home" | "away" | "over" | "under";

export interface BetEvaluation {
  market: BetMarket;
  selection: BetSelection;
  /** Report-ready description, e.g. "Astros ML" or "OVER 8.5". */
  label: string;
  /**
   * The market's line — the run-line spread or the total. Null for moneylines.
   * Carried as a number so settlement (Step 8) never has to parse `label`.
   */
  line: number | null;
  americanOdds: AmericanOdds;
  decimalOdds: number;
  /** Model P(win), unconditional — pushes excluded from both win and lose. */
  modelProbability: number;
  /** Model P(push). Zero for moneylines and half-run lines. */
  pushProbability: number;
  /** Model P(win) conditional on the bet resolving (no push). */
  modelProbabilityNoPush: number;
  /** The book's implied probability *including* its margin. */
  impliedProbabilityRaw: number;
  /** The book's probability with the vig stripped out — the fair comparison. */
  marketProbability: number;
  /** modelProbabilityNoPush − marketProbability. */
  edge: number;
  /** Expected profit per 1 unit staked. */
  ev: number;
  /** `ev` as a percentage, for the report. */
  evPercent: number;
  /** True when the edge clears `minEdge` and EV is positive. */
  isValueBet: boolean;
}

export interface EvOptions {
  /**
   * Minimum edge (as a fraction, e.g. 0.02 = 2 percentage points) before a
   * bet is flagged as value. Below this, the "edge" is mostly model noise.
   */
  minEdge?: number;
}

const DEFAULT_MIN_EDGE = 0.02;

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Expected profit per 1 unit staked.
 *
 * @param decimal Decimal odds.
 * @param pWin    P(the bet wins).
 * @param pLose   P(the bet loses). Any remaining probability is a push, which
 *                returns the stake and so contributes nothing.
 */
export function expectedValue(decimal: number, pWin: number, pLose: number): number {
  return pWin * (decimal - 1) - pLose;
}

/** Build one evaluated bet from a price and the model's probabilities. */
function evaluateBet(
  market: BetMarket,
  selection: BetSelection,
  label: string,
  line: number | null,
  americanOdds: AmericanOdds,
  marketProbability: number,
  pWin: number,
  pPush: number,
  minEdge: number,
): BetEvaluation {
  const decimalOdds = americanToDecimal(americanOdds);
  const pLose = Math.max(0, 1 - pWin - pPush);

  // Conditional on the bet actually resolving — the like-for-like comparison
  // against a de-vigged two-way market.
  const resolving = pWin + pLose;
  const modelProbabilityNoPush = resolving > 0 ? pWin / resolving : 0;

  const edge = modelProbabilityNoPush - marketProbability;
  const ev = expectedValue(decimalOdds, pWin, pLose);

  return {
    market,
    selection,
    label,
    line,
    americanOdds,
    decimalOdds: round(decimalOdds),
    modelProbability: round(pWin),
    pushProbability: round(pPush),
    modelProbabilityNoPush: round(modelProbabilityNoPush),
    impliedProbabilityRaw: round(1 / decimalOdds),
    marketProbability: round(marketProbability),
    edge: round(edge),
    ev: round(ev),
    evPercent: round(ev * 100, 2),
    isValueBet: edge >= minEdge && ev > 0,
  };
}

export interface GameEvaluation {
  gameId: string;
  sportsbook: string;
  /** When the odds were pulled — an EV figure is only meaningful with this. */
  oddsFetchedAt: string;
  /** Every priced bet, sorted by EV descending. */
  bets: BetEvaluation[];
  /** The subset that cleared the edge threshold, best first. */
  valueBets: BetEvaluation[];
  /** Markets the book had not posted, so no bet could be evaluated. */
  skippedMarkets: BetMarket[];
}

/**
 * Evaluate every market a sportsbook posted for one game.
 *
 * Markets the book has not posted are skipped and reported in
 * `skippedMarkets` — a missing market means "no bet here", not an error.
 *
 * @param simulation Output of `simulateGame`.
 * @param odds       The book's posted markets.
 * @param labels     Team names for report-ready bet labels.
 */
export function evaluateOdds(
  simulation: SimulationResult,
  odds: GameOdds,
  labels: { home: string; away: string },
  options: EvOptions = {},
): GameEvaluation {
  const minEdge = options.minEdge ?? DEFAULT_MIN_EDGE;
  const bets: BetEvaluation[] = [];
  const skippedMarkets: BetMarket[] = [];

  /* --- Moneyline: no push is possible ------------------------------------ */
  if (odds.moneyline === null) {
    skippedMarkets.push("moneyline");
  } else {
    const { a: homeMarket, b: awayMarket } = removeVigAmerican(
      odds.moneyline.home,
      odds.moneyline.away,
    );
    bets.push(
      evaluateBet(
        "moneyline",
        "home",
        `${labels.home} ML`,
        null,
        odds.moneyline.home,
        homeMarket,
        simulation.moneyline.home,
        0,
        minEdge,
      ),
      evaluateBet(
        "moneyline",
        "away",
        `${labels.away} ML`,
        null,
        odds.moneyline.away,
        awayMarket,
        simulation.moneyline.away,
        0,
        minEdge,
      ),
    );
  }

  /* --- Run line ---------------------------------------------------------- */
  if (odds.runLine === null) {
    skippedMarkets.push("run_line");
  } else if (odds.runLine.line !== simulation.runLine.line) {
    // Refuse to price a line the simulation did not actually count. Silently
    // comparing a 1.5 simulation against a 2.5 market would be a real bug.
    throw new RangeError(
      `Run-line mismatch: odds are for ${odds.runLine.line} but the simulation ` +
        `used ${simulation.runLine.line}. Re-run simulateGame with { runLine: ${odds.runLine.line} }.`,
    );
  } else {
    const rl = simulation.runLine;
    const { a: homeMarket, b: awayMarket } = removeVigAmerican(
      odds.runLine.homePrice,
      odds.runLine.awayPrice,
    );
    bets.push(
      evaluateBet(
        "run_line",
        "home",
        `${labels.home} -${odds.runLine.line}`,
        odds.runLine.line,
        odds.runLine.homePrice,
        homeMarket,
        rl.homeCoversMinus,
        rl.homeSidePush,
        minEdge,
      ),
      evaluateBet(
        "run_line",
        "away",
        `${labels.away} +${odds.runLine.line}`,
        odds.runLine.line,
        odds.runLine.awayPrice,
        awayMarket,
        rl.awayCoversPlus,
        rl.homeSidePush,
        minEdge,
      ),
    );
  }

  /* --- Total ------------------------------------------------------------- */
  if (odds.total === null) {
    skippedMarkets.push("total");
  } else if (simulation.total.line === null || simulation.total.over === null) {
    throw new RangeError(
      "Odds include a total but the simulation was run without a totalLine. " +
        `Re-run simulateGame with { totalLine: ${odds.total.line} }.`,
    );
  } else if (odds.total.line !== simulation.total.line) {
    throw new RangeError(
      `Total-line mismatch: odds are for ${odds.total.line} but the simulation ` +
        `used ${simulation.total.line}. Re-run simulateGame with { totalLine: ${odds.total.line} }.`,
    );
  } else {
    const t = simulation.total;
    const { a: overMarket, b: underMarket } = removeVigAmerican(
      odds.total.overPrice,
      odds.total.underPrice,
    );
    bets.push(
      evaluateBet(
        "total",
        "over",
        `OVER ${odds.total.line}`,
        odds.total.line,
        odds.total.overPrice,
        overMarket,
        t.over!,
        t.push ?? 0,
        minEdge,
      ),
      evaluateBet(
        "total",
        "under",
        `UNDER ${odds.total.line}`,
        odds.total.line,
        odds.total.underPrice,
        underMarket,
        t.under!,
        t.push ?? 0,
        minEdge,
      ),
    );
  }

  bets.sort((a, b) => b.ev - a.ev);

  return {
    gameId: simulation.gameId,
    sportsbook: odds.sportsbook,
    oddsFetchedAt: odds.fetchedAt,
    bets,
    valueBets: bets.filter((b) => b.isValueBet),
    skippedMarkets,
  };
}

/**
 * Render the "Value:" block from plan Section 6. Only value bets get the ✅;
 * everything else is shown so the reader can see what was considered and
 * rejected, not just what was recommended.
 */
export function explainEvaluation(evaluation: GameEvaluation): string[] {
  if (evaluation.bets.length === 0) {
    return ["Value:       no markets priced"];
  }

  return evaluation.bets.map((b, i) => {
    const prefix = i === 0 ? "Value:      " : "            ";
    const edgePct = `${b.edge >= 0 ? "+" : ""}${(b.edge * 100).toFixed(1)}%`;
    const verdict = b.isValueBet
      ? "(EV positive) ✅"
      : b.ev > 0
        ? "(EV ~ neutral)"
        : "(EV negative)";
    return `${prefix} ${b.label.padEnd(16)} ${edgePct.padStart(6)} edge  ${verdict}`;
  });
}
