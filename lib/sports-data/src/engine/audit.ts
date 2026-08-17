/**
 * Standing audit — the checks the 2026-08 hand audit did once, made repeatable.
 *
 * The daily report (report.ts) already watches calibration and P&L. This
 * module covers the audit checklist items that were still manual:
 *
 *   S-3  integrity — the official numbers must equal an INDEPENDENT re-score
 *        of the raw predictions + results, and the store's invariants must
 *        hold (one history report per date, calibration counters consistent,
 *        every overdue slate settled).
 *   S-4  lock discipline — every slate locked before its deadline, with the
 *        margin tracked so scheduler-delay erosion is visible BEFORE it
 *        becomes another past-deadline incident.
 *   A-1  distribution validity — the simulator's variance/correlation
 *        assumptions (negative binomial r, shared-environment sd) checked
 *        against what actually happened, analytically, per game.
 *   A-4  input-data health — how often the feature pipeline runs degraded
 *        (estimated xFIP, low-sample starters, missing results).
 *   A-5  known losing cohorts — the patterns deliberately left uncorrected
 *        (aligned edges, away picks, EV outliers) tracked until the sample
 *        says corrected-by-variance-fix or needs-its-own-fix.
 *   B-2  store integrity — files parse, dates reconcile, control-tower
 *        handicap notations resolve.
 *
 * Everything here is a PURE function over loaded data: the CLI owns I/O, so
 * tests can feed synthetic days and assert on findings.
 */

import type { GamePrediction } from "./decision";
import { DEFAULT_CALIBRATION, resolveHandicap } from "./decision";
import {
  expectedProfit,
  oppositeParts,
  settleParts,
  WIN_COMMISSION,
  type WeightedLine,
} from "./handicap-notation";
import { isResultsDue, predictionDeadline } from "./deadline";
import { settle, type GameResult, type SettlementReport } from "./settle";
import { SHARED_ENV_SD, TEAM_RUN_DISPERSION } from "./simulate";

/** One slate's worth of on-disk state, as loaded by the CLI. */
export interface AuditDay {
  date: string;
  /** The prediction lock (null when the file is missing or unparseable). */
  lock: {
    lockedAt: string | null;
    predictions: GamePrediction[];
  } | null;
  /** Final scores, when fetched. */
  results: Record<string, GameResult> | null;
  /** The control tower's handicap inputs, for notation validation. */
  controlTowerHandicaps: Record<string, unknown> | null;
}

export interface AuditIssue {
  severity: "error" | "warn";
  /** Stable machine-readable code, e.g. "resettle_mismatch". */
  code: string;
  detail: string;
}

export interface LockMargin {
  date: string;
  /** Minutes between lock and deadline; negative = locked late. */
  marginMinutes: number | null;
  late: boolean;
}

export interface DistributionCheck {
  /** Games with both a result and expected runs. */
  n: number;
  /** Mean |predicted − actual| margin, runs. */
  meanMarginError: number;
  /** Variance of the margin residual (actual − predicted margin). */
  empiricalMarginVariance: number;
  /** What the NB + shared-environment model implies for the same games. */
  modelMarginVariance: number;
  /** Empirical Pearson correlation of the two teams' run residuals. */
  empiricalRunCorrelation: number;
  /** The model's implied same-game correlation for these games. */
  modelRunCorrelation: number;
}

export interface FlagRate {
  flag: string;
  games: number;
  rate: number;
}

export interface CohortStat {
  cohort: string;
  n: number;
  wins: number;
  losses: number;
  hitRate: number | null;
  profit: number;
}

/**
 * A-2: one settled bet on a REAL (non-zero) handicap line, with its whole
 * arithmetic exposed.
 *
 * The 半 family settles as SHARES of the stake — 〈1半2〉 winning by exactly
 * two is +8分, neither a win nor a loss — and none of that machinery has ever
 * run on a production bet: every settled wager so far was quoted at "0". The
 * first real lines are therefore the moment to check the money by hand, and
 * this record exists so that check takes seconds: the line as quoted, the
 * margin from the backed side, the stake split, and the units that fell out.
 */
export interface RealLineSettlement {
  date: string;
  gamePk: number;
  game: string;
  /** The handicap as the slate wrote it (or the signed line). */
  quoted: string;
  /** The bet as the report named it. */
  backed: string;
  /** Final margin from the BACKED side's perspective. */
  margin: number;
  /** Signed lines the backed stake actually sits on. */
  parts: WeightedLine[];
  /** Shares of the stake that won / pushed / lost. */
  win: number;
  push: number;
  loss: number;
  commission: number;
  /** Units recomputed here, from the parts and the margin. */
  profit: number;
  /** Units the settlement recorded, for comparison. */
  storedProfit: number | null;
}

export interface AuditReport {
  generatedAt: string;
  daysAudited: number;
  issues: AuditIssue[];
  lockMargins: LockMargin[];
  distribution: DistributionCheck | null;
  flagRates: FlagRate[];
  cohorts: CohortStat[];
  /** A-2: settled bets on real lines — empty until real lines are quoted. */
  realLines: RealLineSettlement[];
}

/**
 * Analytic moments of one game's margin under the production simulator.
 *
 * With e ~ Gamma(1/s², s²) (mean 1, variance s²) and X|e ~ NB(mu·e, r):
 *   Var[X]    = mu + (mu²/r)(1 + s²) + mu²s²
 *   Cov[H, A] = muH·muA·s²         (the shared factor is the only coupling)
 * so the margin variance is Var[H] + Var[A] − 2Cov. Deriving these here —
 * from the SAME constants the simulator draws with — lets the audit compare
 * "what the model believes about spread" to realized residuals without
 * re-running any simulation.
 */
export function analyticMarginStats(
  muH: number,
  muA: number,
  r: number = TEAM_RUN_DISPERSION,
  envSd: number = SHARED_ENV_SD,
): { varMargin: number; correlation: number } {
  const s2 = envSd * envSd;
  const varOf = (mu: number) => mu + ((mu * mu) / r) * (1 + s2) + mu * mu * s2;
  const varH = varOf(muH);
  const varA = varOf(muA);
  const cov = muH * muA * s2;
  return {
    varMargin: varH + varA - 2 * cov,
    correlation: cov / Math.sqrt(varH * varA),
  };
}

/** S-3 + B-2: invariants across the store, plus the independent re-score. */
export function checkIntegrity(
  days: AuditDay[],
  history: SettlementReport[],
  calibration: { gamesSettled: number },
  now: Date,
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const historyByDate = new Map<string, SettlementReport[]>();
  for (const r of history) {
    historyByDate.set(r.date, [...(historyByDate.get(r.date) ?? []), r]);
  }

  // One history report per date — the invariant that makes re-settles
  // replace rather than double-count.
  for (const [date, reports] of historyByDate) {
    if (reports.length > 1) {
      issues.push({
        severity: "error",
        code: "duplicate_history_date",
        detail: `${date} appears ${reports.length}× in history.jsonl — re-settles must replace, not append`,
      });
    }
  }

  for (const day of days) {
    const overdue = isResultsDue(day.date, now);

    // Control-tower notations must resolve — a typo here breaks predict, so
    // this check runs BEFORE the lock guard: the day a typo matters most is
    // exactly the day predict crashed and produced no lock.
    for (const [gamePk, h] of Object.entries(
      day.controlTowerHandicaps ?? {},
    )) {
      try {
        resolveHandicap(h as Parameters<typeof resolveHandicap>[0]);
      } catch (err) {
        issues.push({
          severity: "error",
          code: "bad_handicap_notation",
          detail: `${day.date} game ${gamePk}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (!day.lock) {
      // A slate (or control tower) exists but predict never locked it — a
      // crashed or skipped run. Only overdue dates count: today's slate
      // legitimately has no lock yet when the audit runs before the cron.
      if (overdue) {
        issues.push({
          severity: "error",
          code: "missing_lock",
          detail: `${day.date}: a slate exists but no prediction lock was ever produced`,
        });
      }
      continue;
    }

    if (overdue && !day.results) {
      issues.push({
        severity: "error",
        code: "missing_results",
        detail: `${day.date}: results were due and are still missing`,
      });
    }
    if (overdue && day.results && !historyByDate.has(day.date)) {
      issues.push({
        severity: "error",
        code: "unsettled_date",
        detail: `${day.date}: results exist but the date was never settled into history`,
      });
    }

    // Independent re-score: settle the raw lock against the raw results and
    // demand the official history agrees. Calibration state does not affect
    // scoring, so DEFAULT-equivalent state is irrelevant here — only the
    // records and money are compared.
    const official = historyByDate.get(day.date)?.[0];
    if (day.results && official) {
      const fresh = settle(
        day.date,
        day.lock.predictions,
        day.results,
        DEFAULT_CALIBRATION,
        now,
      );
      const mismatch = (what: string, a: unknown, b: unknown) =>
        issues.push({
          severity: "error",
          code: "resettle_mismatch",
          detail: `${day.date}: independent re-score disagrees on ${what} (official ${JSON.stringify(a)}, recomputed ${JSON.stringify(b)})`,
        });
      if (
        official.winnerRecord.wins !== fresh.winnerRecord.wins ||
        official.winnerRecord.losses !== fresh.winnerRecord.losses
      ) {
        mismatch("winner record", official.winnerRecord, fresh.winnerRecord);
      }
      if (
        official.handicapRecord.wins !== fresh.handicapRecord.wins ||
        official.handicapRecord.losses !== fresh.handicapRecord.losses
      ) {
        mismatch(
          "handicap record",
          official.handicapRecord,
          fresh.handicapRecord,
        );
      }
      if ((official.handicapProfit ?? 0) !== (fresh.handicapProfit ?? 0)) {
        mismatch(
          "handicap profit",
          official.handicapProfit,
          fresh.handicapProfit,
        );
      }
    }
  }

  // The learning counter must equal the winner-market samples the history
  // actually holds — drift here means the state learned from games the
  // record cannot account for (or missed some).
  const scoredInHistory = [...historyByDate.values()]
    .flatMap((rs) => rs[0]!.games)
    .filter((g) => g.winnerCorrect !== null && g.statedProbability !== null)
    .length;
  if (calibration.gamesSettled !== scoredInHistory) {
    issues.push({
      severity: "error",
      code: "calibration_counter_drift",
      detail: `calibration.gamesSettled=${calibration.gamesSettled} but history holds ${scoredInHistory} scored winner bets`,
    });
  }

  return issues;
}

/**
 * S-4: how close each slate's lock came to its deadline.
 *
 * Each prediction stores the `lockDeadline` that was IN FORCE when it was
 * made, and that stored value is what a slate is judged against — the
 * deadline has already moved twice (22:21 → 22:55 JST), and grading July's
 * locks against August's rule would manufacture lateness that never
 * happened (or absolve lateness that did). Slates from before the field
 * existed fall back to the current rule.
 */
export function lockMargins(days: AuditDay[]): LockMargin[] {
  return days
    .filter((d) => d.lock)
    .map((d) => {
      const lockedAt = d.lock!.lockedAt ? new Date(d.lock!.lockedAt) : null;
      if (!lockedAt || Number.isNaN(lockedAt.getTime())) {
        return { date: d.date, marginMinutes: null, late: false };
      }
      const stored = d.lock!.predictions.find(
        (p) => p.lockDeadline != null,
      )?.lockDeadline;
      const deadline = stored ? new Date(stored) : predictionDeadline(d.date);
      const margin = (deadline.getTime() - lockedAt.getTime()) / 60_000;
      return {
        date: d.date,
        marginMinutes: Math.round(margin * 10) / 10,
        late: margin < 0,
      };
    });
}

/** A-1: realized margins vs the simulator's analytic spread. */
export function distributionCheck(
  days: AuditDay[],
  r: number = TEAM_RUN_DISPERSION,
  envSd: number = SHARED_ENV_SD,
): DistributionCheck | null {
  const rows: Array<{
    muH: number;
    muA: number;
    h: number;
    a: number;
  }> = [];
  for (const d of days) {
    if (!d.lock || !d.results) continue;
    for (const p of d.lock.predictions) {
      const r = d.results[String(p.gamePk)];
      if (!r) continue;
      rows.push({
        muH: p.expectedRuns.home,
        muA: p.expectedRuns.away,
        h: r.homeScore,
        a: r.awayScore,
      });
    }
  }
  if (rows.length < 10) return null;

  const residMargin = rows.map((r) => r.h - r.a - (r.muH - r.muA));
  const residH = rows.map((r) => r.h - r.muH);
  const residA = rows.map((r) => r.a - r.muA);
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = (xs: number[]) => {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const mH = mean(residH);
  const mA = mean(residA);
  const cov =
    rows.reduce((s, _, i) => s + (residH[i]! - mH) * (residA[i]! - mA), 0) /
    (rows.length - 1);

  const analytic = rows.map((g) => analyticMarginStats(g.muH, g.muA, r, envSd));

  return {
    n: rows.length,
    meanMarginError: round2(mean(residMargin.map(Math.abs))),
    empiricalMarginVariance: round2(variance(residMargin)),
    modelMarginVariance: round2(mean(analytic.map((s) => s.varMargin))),
    empiricalRunCorrelation: round3(
      cov / Math.sqrt(variance(residH) * variance(residA)),
    ),
    modelRunCorrelation: round3(mean(analytic.map((s) => s.correlation))),
  };
}

/** A-4: how often each data-quality flag appears on a slate's games. */
export function flagRates(days: AuditDay[]): FlagRate[] {
  const counts = new Map<string, number>();
  let games = 0;
  for (const d of days) {
    if (!d.lock) continue;
    for (const p of d.lock.predictions) {
      games++;
      // Count each flag once per game; the audit's own lateness/outlier
      // flags are cohort material (A-5), not input-data health.
      for (const f of new Set(p.flags)) {
        if (f === "[warn] predicted_after_deadline") continue;
        if (f === "[warn] ev_outlier") continue;
        counts.set(f, (counts.get(f) ?? 0) + 1);
      }
    }
  }
  if (games === 0) return [];
  return [...counts.entries()]
    .map(([flag, n]) => ({ flag, games: n, rate: round3(n / games) }))
    .sort((a, b) => b.games - a.games);
}

/**
 * A-5 (+A-2 readiness): the cohorts worth watching, scored like the audit
 * scored them. "New engine" is detected by the rawCoverProbability field the
 * overhaul introduced, so pre- and post-fix bets never blur together.
 */
export function cohorts(days: AuditDay[]): CohortStat[] {
  interface Scored {
    p: GamePrediction;
    correct: boolean | null;
    profit: number;
  }
  const scored: Scored[] = [];
  for (const d of days) {
    if (!d.lock || !d.results) continue;
    const report = settle(
      d.date,
      d.lock.predictions,
      d.results,
      DEFAULT_CALIBRATION,
      new Date(0),
    );
    for (const g of report.games) {
      if (g.pass) continue;
      const p = d.lock.predictions.find((x) => x.gamePk === g.gamePk);
      if (!p) continue;
      scored.push({
        p,
        correct: g.handicapCorrect,
        profit: g.handicapProfit ?? 0,
      });
    }
  }

  const winner = (p: GamePrediction) => p.predictedWinner ?? "";
  const defs: Array<[string, (s: Scored) => boolean]> = [
    [
      "starter+offense edges aligned",
      (s) =>
        s.p.reasons.some(
          (x) => x.startsWith("Starter edge") && x.includes(winner(s.p)),
        ) &&
        s.p.reasons.some(
          (x) => x.startsWith("Offense edge") && x.includes(winner(s.p)),
        ),
    ],
    ["away-team picks", (s) => s.p.predictedWinner === s.p.away],
    ["ev_outlier flagged", (s) => s.p.flags.includes("[warn] ev_outlier")],
    [
      "real handicap line (non-zero)",
      // Judged by what the input RESOLVES to, not its spelling: "なし",
      // "0.0" and full-width zeros all mean the same no-handicap line as
      // "0", and none of them may trip the A-2 real-line wire.
      (s) => {
        if (!s.p.handicap.input) return false;
        try {
          return resolveHandicap(s.p.handicap.input).effectiveLine !== 0;
        } catch {
          return false;
        }
      },
    ],
    [
      "new engine (post-overhaul)",
      (s) => s.p.handicap.rawCoverProbability !== undefined,
    ],
  ];

  return defs.map(([cohort, match]) => {
    const inCohort = scored.filter(match);
    const decided = inCohort.filter((s) => s.correct !== null);
    const wins = decided.filter((s) => s.correct === true).length;
    return {
      cohort,
      n: decided.length,
      wins,
      losses: decided.length - wins,
      hitRate: decided.length === 0 ? null : round3(wins / decided.length),
      profit: round3(inCohort.reduce((a, s) => a + s.profit, 0)),
    };
  });
}

/**
 * A-2: re-derive every settled REAL-line bet from the lock's own notation and
 * the real final score, then check the arithmetic against invariants that
 * hold for any correct settlement — not against the settlement code's own
 * opinion of itself:
 *
 *   - the stake is fully accounted for: win + push + loss = 1
 *   - the money follows the shares: profit = (1 − c)·win − loss
 *   - the money stays in range: −1 ≤ profit ≤ 1 − c
 *   - the recomputation agrees with what settlement recorded
 *
 * Zero-line bets are skipped: they settle as a plain win/loss and are already
 * covered by the whole settled record.
 */
export function realLineSettlements(days: AuditDay[]): {
  settlements: RealLineSettlement[];
  issues: AuditIssue[];
} {
  const settlements: RealLineSettlement[] = [];
  const issues: AuditIssue[] = [];

  for (const day of days) {
    if (!day.lock || !day.results) continue;
    for (const p of day.lock.predictions) {
      const input = p.handicap.input;
      if (p.pass || !p.handicap.pick || !input) continue;
      const result = day.results[String(p.gamePk)];
      if (!result) continue;

      let resolved;
      try {
        resolved = resolveHandicap(input);
      } catch {
        continue; // notation errors are reported by checkIntegrity
      }
      if (resolved.effectiveLine === 0) continue; // pick'em: nothing special

      // Same derivation settlement uses, from the raw score.
      const actualMargin = result.homeScore - result.awayScore;
      const quotedSideMargin =
        input.side === "home" ? actualMargin : -actualMargin;
      const pickedQuotedSide = p.handicap.pick.startsWith(
        input.side === "home" ? p.home : p.away,
      );
      const parts = pickedQuotedSide
        ? resolved.parts
        : oppositeParts(resolved.parts);
      const margin = pickedQuotedSide ? quotedSideMargin : -quotedSideMargin;
      const outcome = settleParts(parts, margin);
      const profit = round3(expectedProfit(outcome));

      const where = `${day.date} ${p.away} @ ${p.home} (${p.handicap.pick})`;
      const shareSum = outcome.win + outcome.push + outcome.loss;
      if (Math.abs(shareSum - 1) > 1e-9) {
        issues.push({
          severity: "error",
          code: "real_line_share_sum",
          detail: `${where}: stake shares sum to ${shareSum}, not 1`,
        });
      }
      const fromShares =
        outcome.win * (1 - WIN_COMMISSION) - outcome.loss;
      if (Math.abs(fromShares - profit) > 1e-6) {
        issues.push({
          severity: "error",
          code: "real_line_profit_formula",
          detail: `${where}: ${profit}u does not equal (1−${WIN_COMMISSION})·win − loss = ${fromShares}`,
        });
      }
      if (profit < -1 - 1e-9 || profit > 1 - WIN_COMMISSION + 1e-9) {
        issues.push({
          severity: "error",
          code: "real_line_profit_range",
          detail: `${where}: ${profit}u is outside the possible [-1, ${1 - WIN_COMMISSION}]`,
        });
      }

      settlements.push({
        date: day.date,
        gamePk: p.gamePk,
        game: `${p.away} @ ${p.home}`,
        quoted:
          input.notation !== undefined
            ? input.notation
            : `line ${input.line}`,
        backed: p.handicap.pick,
        margin,
        parts,
        win: round3(outcome.win),
        push: round3(outcome.push),
        loss: round3(outcome.loss),
        commission: WIN_COMMISSION,
        profit,
        storedProfit: null,
      });
    }
  }

  return { settlements, issues };
}

export function runAudit(
  days: AuditDay[],
  history: SettlementReport[],
  calibration: { gamesSettled: number },
  now: Date,
): AuditReport {
  const issues = checkIntegrity(days, history, calibration, now);
  const margins = lockMargins(days);
  const realLines = realLineSettlements(days);
  issues.push(...realLines.issues);

  // Cross-check the recomputation against what settlement actually recorded.
  const recordedProfit = new Map<string, number>();
  for (const r of history) {
    for (const g of r.games) {
      if (g.handicapProfit !== null) {
        recordedProfit.set(`${r.date}:${g.gamePk}`, g.handicapProfit);
      }
    }
  }
  for (const s of realLines.settlements) {
    const stored = recordedProfit.get(`${s.date}:${s.gamePk}`);
    if (stored === undefined) continue;
    s.storedProfit = stored;
    if (Math.abs(stored - s.profit) > 1e-6) {
      issues.push({
        severity: "error",
        code: "real_line_profit_mismatch",
        detail: `${s.date} game ${s.gamePk}: settlement recorded ${stored}u, recomputing from 〈${s.quoted}〉 and margin ${s.margin} gives ${s.profit}u`,
      });
    }
  }

  // A late lock is an ERROR when it is recent AND the slate was produced
  // under the deadline rule currently in force (its stored lockDeadline is
  // the instant the current rule yields for that date; slates from before
  // the raw field existed count as current-rule). Two deliberate edges:
  //
  //   - Late locks from a superseded rule era never gate the run red — the
  //     transition weeks after a deadline change would otherwise stay red
  //     for history that cannot recur, training the operator to ignore red.
  //     They remain fully visible in the S-4 section; only the exit code
  //     forgives them. Accepted cost: a rule change also amnesties a late
  //     lock made JUST before it — rare, still displayed, judged worth it.
  //   - The window is 14 days — two weekly cycles — so one failed or
  //     skipped audit run cannot silently age a late lock out of range.
  const windowStart = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  for (const m of margins) {
    if (!m.late || m.marginMinutes === null) continue;
    const d = days.find((x) => x.date === m.date);
    const lockedAt = d?.lock?.lockedAt ? new Date(d.lock.lockedAt) : null;
    if (lockedAt === null || lockedAt.getTime() < windowStart) continue;
    const stored = d?.lock?.predictions.find(
      (p) => p.lockDeadline != null,
    )?.lockDeadline;
    const producedUnderCurrentRule =
      !stored ||
      new Date(stored).getTime() === predictionDeadline(m.date).getTime();
    if (producedUnderCurrentRule) {
      issues.push({
        severity: "error",
        code: "late_lock",
        detail: `${m.date}: locked ${Math.abs(m.marginMinutes)} min after the deadline`,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    daysAudited: days.length,
    issues,
    lockMargins: margins,
    distribution: distributionCheck(days),
    flagRates: flagRates(days),
    cohorts: cohorts(days),
    realLines: realLines.settlements,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
