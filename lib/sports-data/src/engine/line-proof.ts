/**
 * A-2 — proving the REAL-line machinery before real money rides on it.
 *
 * Every handicap this tool has ever settled was quoted at `0`. A 0 line is a
 * pick'em: one line, no split stake, no partial push, and a settlement that
 * cannot tell a sign error from a correct answer because both sides of a 0
 * line are the same line. So the whole 半 apparatus — split stakes, part
 * pushes, the 分 payout ladder, the 10% cut on the winning share — has never
 * once run on a production bet, and the audit's A-2 section could only say
 * "hand-check the first ones when they arrive".
 *
 * That is the right instruction for the BOOK's arithmetic, which only the
 * book's own statement can confirm. It is the wrong instruction for OUR
 * arithmetic, which does not need a real bet to be checked: the whole
 * quotable line space is small enough to settle exhaustively, offline, every
 * time the audit runs.
 *
 * This module does exactly that. For every line the control tower can quote,
 * on either side, backed either way, against every plausible final margin, it
 * pushes the case through the PRODUCTION path — `decide()` prices it,
 * `settle()` books it — and checks the money against properties that hold for
 * any correct settlement, derived here from the notation alone:
 *
 *   accounting   win + push + loss = 1, and every weight is a positive share
 *   money        profit = (1 − commission)·win − loss, inside [−1, 1 − c]
 *   symmetry     backing the other side mirrors it: win ↔ loss, push equal
 *   monotone     a better margin for the backed side never pays less
 *   ladder       N半X winning by exactly N+1 pays (10−X)/10, less the cut
 *   side         the recorded side and the report's label name the same team
 *   end-to-end   what `settle()` books equals what the notation implies
 *
 * The symmetry and side checks are the ones that matter most: an arithmetic
 * slip usually breaks the accounting identity and shows up immediately, while
 * a SIGN slip — reading the bet as the other side of the line — settles to a
 * number that is internally consistent and completely wrong. At a pick'em it
 * is undetectable; at 〈1半2〉 it turns −1 into +0.72.
 *
 * What this cannot prove stays out of scope on purpose: that the book settles
 * the same way we do. That is what the first real settled line is for, and
 * the audit still prints those rows for hand-checking.
 */

import {
  backedSide,
  decide,
  DEFAULT_CALIBRATION,
  DEFAULT_DECISION_CONFIG,
  type GamePrediction,
  type HandicapInput,
} from "./decision";
import {
  expectedProfit,
  oppositeParts,
  parseHandicapNotation,
  settleParts,
  WIN_COMMISSION,
  type StakeOutcome,
  type WeightedLine,
} from "./handicap-notation";
import { settle } from "./settle";
import { simulateGame, type SimulationResult } from "./simulate";
import type { GameCoreData, TeamCoreData } from "../step2";

export interface LineProofFailure {
  /** Stable machine-readable code, e.g. "share_sum". */
  code: string;
  notation: string;
  detail: string;
}

/** One row of the 半 ladder, kept so the report can show the money. */
export interface LadderRow {
  notation: string;
  /** The backed (giving) side's margin. */
  margin: number;
  win: number;
  push: number;
  loss: number;
  profit: number;
}

export interface LineProofReport {
  /** Notations proved, in the order they were enumerated. */
  notations: string[];
  /** Margins each notation was settled against. */
  margins: number[];
  /** notations × quoted sides × priced predictions × margins. */
  cases: number;
  /**
   * How many of those cases the model backed each way. Both must be non-zero:
   * a proof that only ever books the giving side would miss precisely the
   * sign errors it exists to catch.
   */
  backed: { home: number; away: number };
  /** Individual property checks performed across those cases. */
  checks: number;
  failures: LineProofFailure[];
  /** 〈1半X〉 at the margin where the split stake actually splits. */
  ladder: LadderRow[];
}

/**
 * The lines a control tower can actually quote.
 *
 * Plain tenths up to 2.9 and the 半 family up to 2半9 cover every handicap the
 * slates have ever carried with room to spare (baseball run lines live inside
 * ±3). `0` is deliberately absent: a pick'em is not a real line, and the whole
 * point of this proof is the machinery a pick'em never reaches.
 */
export function quotableNotations(): string[] {
  const out: string[] = [];
  for (let tenths = 1; tenths <= 29; tenths++) {
    out.push((tenths / 10).toFixed(1));
  }
  for (let whole = 0; whole <= 2; whole++) {
    for (let digit = 0; digit <= 9; digit++) {
      out.push(digit === 0 ? `${whole}半` : `${whole}半${digit}`);
    }
  }
  return out;
}

/** Final margins to settle against: every MLB scoreline that matters. */
const DEFAULT_MARGINS = Array.from({ length: 17 }, (_, i) => i - 8);

/**
 * What the notation says the bet is worth, derived WITHOUT the production
 * resolver: parse the notation, sign it by hand for the side holding it, and
 * settle. Checking `resolveHandicap`'s output against `resolveHandicap` would
 * prove only that it is consistent with itself.
 */
function reference(
  notation: string,
  quotedSide: "home" | "away",
  backed: "home" | "away",
  homeMargin: number,
): { parts: WeightedLine[]; outcome: StakeOutcome; profit: number } {
  const parsed = parseHandicapNotation(notation);
  // The notation is what the quoted side GIVES, so its own lines are negative.
  const quotedParts = oppositeParts(parsed.parts);
  const quotedMargin = quotedSide === "home" ? homeMargin : -homeMargin;
  const parts = backed === quotedSide ? quotedParts : parsed.parts;
  const margin = backed === quotedSide ? quotedMargin : -quotedMargin;
  const outcome = settleParts(parts, margin);
  return { parts, outcome, profit: expectedProfit(outcome) };
}

/** A synthetic game whose only job is to carry a handicap through `decide`. */
function syntheticGame(): GameCoreData {
  const team = (id: number, name: string): TeamCoreData => ({
    teamId: id,
    teamName: name,
    starter: null,
    batting: null,
    bullpen: null,
    form: null,
  });
  return {
    gamePk: 1,
    gameDate: null,
    venue: { id: null, name: null },
    parkFactor: 100,
    // Names that are NOT prefixes of one another, so the legacy label
    // fallback is exercised the same way MLB's own names exercise it.
    home: team(1, "Home Bears"),
    away: team(2, "Away Wolves"),
    flags: [],
    complete: true,
  };
}

export interface LineProofOptions {
  notations?: string[];
  margins?: number[];
}

/**
 * Settle the whole quotable line space through the production path and check
 * every property that must hold.
 *
 * Pure and offline: one pair of simulations (home-favoured and away-favoured,
 * so both sides of every line get backed) is reused across all cases, and no
 * file, network or clock is touched.
 */
export function verifyLineSettlement(
  opts: LineProofOptions = {},
): LineProofReport {
  const notations = opts.notations ?? quotableNotations();
  const margins = opts.margins ?? DEFAULT_MARGINS;
  const failures: LineProofFailure[] = [];
  const ladder: LadderRow[] = [];
  let checks = 0;
  let cases = 0;
  const backedCases = { home: 0, away: 0 };

  const fail = (code: string, notation: string, detail: string) =>
    failures.push({ code, notation, detail });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  const game = syntheticGame();
  // Gate nothing: this proves the settlement path, so every line must produce
  // a pick rather than being filtered out as a thin edge or a bad price.
  const cfg = { ...DEFAULT_DECISION_CONFIG, passThreshold: 0, minEv: -2 };
  const sims: SimulationResult[] = [
    simulateGame(5.4, 3.9, { sims: 4000, seed: "line-proof:home" }),
    simulateGame(3.9, 5.4, { sims: 4000, seed: "line-proof:away" }),
  ];
  const runs = {
    homeMu: 5.4,
    awayMu: 3.9,
    leagueRunsPerGame: 4.5,
    notes: [],
  };

  for (const notation of notations) {
    for (const quotedSide of ["home", "away"] as const) {
      const input: HandicapInput = { side: quotedSide, notation };

      // One prediction per simulation: the model backs the side it prefers,
      // so the favoured/unfavoured pair covers backing BOTH sides of the line.
      const predictions: GamePrediction[] = sims.map((sim) =>
        decide(game, runs, sim, DEFAULT_CALIBRATION, input, cfg),
      );

      for (const p of predictions) {
        checks++;
        const backed = backedSide(p);
        if (backed === null || p.handicap.pick === null) {
          fail(
            "no_pick",
            notation,
            `${quotedSide}-quoted line produced no handicap pick — the proof cannot see the settlement path`,
          );
          continue;
        }

        // The label a human reads and the side the money follows must name the
        // same team. A divergence here is invisible in the report and fatal in
        // the settlement.
        checks++;
        const backedName = backed === "home" ? p.home : p.away;
        if (!p.handicap.pick.startsWith(backedName)) {
          fail(
            "label_side_mismatch",
            notation,
            `pick "${p.handicap.pick}" does not name the backed side (${backed} = ${backedName})`,
          );
        }

        let previousProfit: number | null = null;
        for (const homeMargin of margins) {
          cases++;
          backedCases[backed]++;
          const ref = reference(notation, quotedSide, backed, homeMargin);
          const { outcome } = ref;

          // Accounting: the stake is fully allocated, in real shares.
          checks++;
          const shareSum = outcome.win + outcome.push + outcome.loss;
          if (!near(shareSum, 1)) {
            fail(
              "share_sum",
              notation,
              `${quotedSide}-quoted, backed ${backed}, margin ${homeMargin}: shares sum to ${shareSum}`,
            );
          }

          // Money: the payout formula and its range.
          checks++;
          const fromShares =
            outcome.win * (1 - WIN_COMMISSION) - outcome.loss;
          if (!near(fromShares, ref.profit)) {
            fail(
              "profit_formula",
              notation,
              `${quotedSide}-quoted, backed ${backed}, margin ${homeMargin}: ${ref.profit} ≠ (1−${WIN_COMMISSION})·win − loss = ${fromShares}`,
            );
          }
          checks++;
          if (
            ref.profit < -1 - 1e-9 ||
            ref.profit > 1 - WIN_COMMISSION + 1e-9
          ) {
            fail(
              "profit_range",
              notation,
              `${quotedSide}-quoted, backed ${backed}, margin ${homeMargin}: ${ref.profit} is outside [−1, ${1 - WIN_COMMISSION}]`,
            );
          }

          // Symmetry: the other side of the same line at the same score.
          checks++;
          const other = backed === "home" ? "away" : "home";
          const mirror = reference(notation, quotedSide, other, homeMargin);
          if (
            !near(mirror.outcome.win, outcome.loss) ||
            !near(mirror.outcome.loss, outcome.win) ||
            !near(mirror.outcome.push, outcome.push)
          ) {
            fail(
              "side_symmetry",
              notation,
              `${quotedSide}-quoted, margin ${homeMargin}: backing ${backed} gives ${JSON.stringify(outcome)}, backing ${other} gives ${JSON.stringify(mirror.outcome)} — not mirror images`,
            );
          }

          // Monotone: margins are enumerated from the HOME side, so a better
          // home margin must never pay a home-backing stake less (and never
          // pay an away-backing stake more).
          if (previousProfit !== null) {
            checks++;
            const improved =
              backed === "home"
                ? ref.profit - previousProfit
                : previousProfit - ref.profit;
            if (improved < -1e-9) {
              fail(
                "monotonicity",
                notation,
                `${quotedSide}-quoted, backed ${backed}: margin ${homeMargin} pays ${ref.profit} against ${previousProfit} one run earlier`,
              );
            }
          }
          previousProfit = ref.profit;

          // End-to-end: what the production settler books for this pick.
          checks++;
          const report = settle(
            "2026-01-01",
            [p],
            {
              [String(p.gamePk)]:
                homeMargin >= 0
                  ? { homeScore: 3 + homeMargin, awayScore: 3 }
                  : { homeScore: 3, awayScore: 3 - homeMargin },
            },
            DEFAULT_CALIBRATION,
            new Date(0),
          );
          const booked = report.games[0]?.handicapProfit ?? null;
          if (booked === null || Math.abs(booked - ref.profit) > 1e-3) {
            fail(
              "settlement_mismatch",
              notation,
              `${quotedSide}-quoted, backed ${backed}, margin ${homeMargin}: settle() booked ${booked}u, the notation implies ${round3(ref.profit)}u`,
            );
          }

          // The win/loss column must agree with where the stake mostly went.
          checks++;
          const expectedCorrect =
            outcome.win === outcome.loss ? null : outcome.win > outcome.loss;
          const bookedCorrect = report.games[0]?.handicapCorrect ?? null;
          if (bookedCorrect !== expectedCorrect) {
            fail(
              "record_mismatch",
              notation,
              `${quotedSide}-quoted, backed ${backed}, margin ${homeMargin}: recorded ${bookedCorrect}, shares say ${expectedCorrect}`,
            );
          }
        }
      }
    }
  }

  // Ladder: N半X settled by the giving side at exactly N+1 must pay
  // (10−X)/10 of the stake, less the cut — the published 分 table, which is
  // the one part of this the operator can check against the slate by eye.
  for (const notation of notations) {
    const m = /^(\d+)半(\d)?$/.exec(notation);
    if (!m) continue;
    const whole = Number(m[1]);
    const digit = m[2] === undefined ? 0 : Number(m[2]);
    const margin = whole + 1;
    const { outcome, profit } = reference(notation, "home", "home", margin);
    const expected = ((10 - digit) / 10) * (1 - WIN_COMMISSION);
    checks++;
    if (!near(profit, expected)) {
      fail(
        "ladder",
        notation,
        `winning by exactly ${margin} pays ${profit}, the ${10 - digit}分 ladder says ${expected}`,
      );
    }
    ladder.push({
      notation,
      margin,
      win: round3(outcome.win),
      push: round3(outcome.push),
      loss: round3(outcome.loss),
      profit: round3(profit),
    });
  }

  // A side never backed is a hole in the proof, not a clean result.
  for (const side of ["home", "away"] as const) {
    checks++;
    if (backedCases[side] === 0) {
      fail(
        "side_never_backed",
        "*",
        `no case in the whole sweep backed the ${side} side — the sign of a ${side} stake is unproven`,
      );
    }
  }

  return {
    notations,
    margins,
    cases,
    backed: backedCases,
    checks,
    failures,
    ladder,
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
