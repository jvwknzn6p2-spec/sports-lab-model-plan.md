/**
 * Phone-readable Markdown renderings of the daily output.
 *
 * The CLI console report assumes a wide terminal. When HandiEdge runs
 * unattended (GitHub Actions) the deliverable is a file you open on a phone,
 * so these renderers keep lines short, lead with the pick, and avoid wide
 * tables that force horizontal scrolling on a narrow screen.
 */

import type { AuditReport } from "../engine/audit";
import {
  LOCK_MARGIN_WARN_MINUTES,
  LOCK_WINDOW_DAYS,
} from "../engine/audit";
import type { CalibrationState, GamePrediction } from "../engine/decision";
import { fmtPct, fmtUnits, rankByValue } from "../engine/decision";
import {
  marketRecordLabel,
  TOTAL_MARKET_NEVER_QUOTED,
  type CalibrationBucket,
  type HistorySummary,
} from "../engine/report";
import type { SettlementReport } from "../engine/settle";
import { pickTrackerBlock } from "./pick-tracker";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** One calibration band, flag included — the flag is decided in report.ts. */
function bucketLine(b: CalibrationBucket): string {
  const flag =
    b.flag === "overconfident"
      ? " ⚠️ overconfident"
      : b.flag === "underconfident"
        ? " (underconfident)"
        : "";
  return (
    `- ${pct(b.lo)}–${pct(b.hi)}: said ${pct(b.statedMean)}, ` +
    `hit ${pct(b.actualRate)} over ${b.n} (gap ${(b.gap * 100).toFixed(1)}pt)${flag}`
  );
}

export function predictionsToMarkdown(
  date: string,
  predictions: GamePrediction[],
  calibration: CalibrationState,
): string {
  const picks = predictions.filter((p) => !p.pass);
  const passes = predictions.filter((p) => p.pass);
  const out: string[] = [];

  out.push(`# HandiEdge — ${date}`);
  out.push("");
  out.push(
    `**${picks.length} pick${picks.length === 1 ? "" : "s"}**, ` +
      `${passes.length} PASS, out of ${predictions.length} game${predictions.length === 1 ? "" : "s"}.`,
  );
  out.push("");

  if (picks.length === 0) {
    out.push("_No game cleared the confidence threshold today._");
    out.push("");
  }

  // Ordered by expected value (see rankByValue): the numbering below is the
  // 優先度 list, and the Pick Tracker block at the foot of this same file is
  // numbered from the same function so the two can never disagree.
  const sorted = rankByValue(picks);

  sorted.forEach((p, i) => {
    out.push(`## ${i + 1}. ${p.away} @ ${p.home}`);
    out.push("");
    out.push(`**${p.predictedWinner}** to win — ${pct(p.winProbability)}`);
    out.push("");
    out.push(`- Confidence: **${p.confidence}**`);
    out.push(`- Losing side: ${p.predictedLoser}`);
    if (p.handicap.pick) {
      out.push(
        `- Handicap: **${p.handicap.pick}** (${pct(p.handicap.coverProbability!)})` +
          (p.handicap.ev === null
            ? ""
            : ` · EV **${fmtPct(p.handicap.ev)}** per unit`),
      );
    } else if (p.handicap.noValue) {
      // The game is still a pick — only this market is skipped, and saying so
      // is the point: it is the difference between "no opinion" and "the
      // opinion is not worth the price".
      out.push(
        `- Handicap: **no bet at this line** (${pct(p.handicap.coverProbability!)}, ` +
          `EV ${fmtPct(p.handicap.ev!)} per unit)`,
      );
    }
    if (p.total.pick) {
      out.push(
        `- Total: **${p.total.pick} ${p.total.line}** (${pct(p.total.probability!)}, model ${p.total.predicted})`,
      );
    }
    out.push(
      `- Expected runs: ${p.home} ${p.expectedRuns.home} — ${p.away} ${p.expectedRuns.away}`,
    );
    out.push("");
    out.push("Why:");
    for (const r of p.reasons.slice(0, 5)) out.push(`- ${r}`);
    out.push("");
  });

  if (passes.length > 0) {
    out.push("## PASS");
    out.push("");
    for (const p of passes) {
      out.push(
        `- ${p.away} @ ${p.home} — lean ${pct(p.winProbability)}; ` +
          `${p.reasons[0] ?? "below threshold"}`,
      );
    }
    out.push("");
  }

  // Paste target for the Pick Tracker Pro phone app (see pick-tracker.ts).
  const paste = pickTrackerBlock(date, predictions);
  if (paste) {
    out.push("## Pick Tracker Pro 貼り付け用");
    out.push("");
    out.push("```");
    out.push(paste.trimEnd());
    out.push("```");
    out.push("");
  }

  out.push("---");
  out.push(
    `_Shrink (core/tail): moneyline ${calibration.shrink}/${calibration.tailShrink}, ` +
      `handicap ${calibration.handicapShrink}/${calibration.handicapTailShrink}, ` +
      `total ${calibration.totalShrink}/${calibration.totalTailShrink} · ` +
      `${calibration.gamesSettled} games settled lifetime._`,
  );
  return out.join("\n") + "\n";
}

export function settlementToMarkdown(r: SettlementReport): string {
  const out: string[] = [];
  out.push(`# Settled — ${r.date}`);
  out.push("");
  out.push(
    `Winner **${r.winnerRecord.wins}-${r.winnerRecord.losses}** · ` +
      `Handicap ${r.handicapRecord.wins}-${r.handicapRecord.losses}` +
      (r.handicapProfit === null
        ? " · "
        : ` (**${fmtUnits(r.handicapProfit)}** units) · `) +
      `Total ${r.totalRecord.wins}-${r.totalRecord.losses}`,
  );
  out.push("");
  for (const g of r.games) {
    if (g.pass) {
      out.push(
        `- ${g.away} @ ${g.home}: PASS (${g.actualWinner ? `won by ${g.actualWinner}` : "引き分け"})`,
      );
      continue;
    }
    if (g.winnerCorrect === null) {
      // Tie: the moneyline pushed, so it is neither a win nor a loss.
      out.push(
        `- ${g.away} @ ${g.home}: **PUSH (引き分け)** — ` +
          `picked ${g.predictedWinner}, stake returned`,
      );
      continue;
    }
    out.push(
      `- ${g.away} @ ${g.home}: **${g.winnerCorrect ? "WIN" : "LOSS"}** — ` +
        `picked ${g.predictedWinner} at ${pct(g.statedProbability!)}, ` +
        `${g.actualWinner} won` +
        (g.handicapProfit === null
          ? ""
          : ` · ハンデ ${g.handicapPick} ${fmtUnits(g.handicapProfit)}`),
    );
  }
  out.push("");
  if (r.meanBrier !== null) out.push(`- Mean Brier: ${r.meanBrier}`);
  if (r.statedVsActual) {
    out.push(
      `- Calibration: stated ${pct(r.statedVsActual.statedMean)} vs actual ${pct(r.statedVsActual.actualRate)}`,
    );
  }
  out.push(
    `- Self-learning — moneyline ${r.calibrationBefore.shrink} → ${r.calibrationAfter.shrink} ` +
      `(tail ${r.calibrationBefore.tailShrink} → ${r.calibrationAfter.tailShrink}), ` +
      `handicap ${r.calibrationBefore.handicapShrink} → ${r.calibrationAfter.handicapShrink} ` +
      `(tail ${r.calibrationBefore.handicapTailShrink} → ${r.calibrationAfter.handicapTailShrink}), ` +
      `total ${r.calibrationBefore.totalShrink} → ${r.calibrationAfter.totalShrink} ` +
      `(tail ${r.calibrationBefore.totalTailShrink} → ${r.calibrationAfter.totalTailShrink})`,
  );
  if (r.gamesMissingResults > 0) {
    out.push(`- ${r.gamesMissingResults} game(s) had no result yet`);
  }
  return out.join("\n") + "\n";
}

export function summaryToMarkdown(
  s: HistorySummary,
  calibration: CalibrationState,
): string {
  const out: string[] = [];
  out.push("# HandiEdge — running results");
  out.push("");
  out.push(
    `**${s.winnerRecord.wins}-${s.winnerRecord.losses}**` +
      (s.winnerRate === null ? "" : ` (${pct(s.winnerRate)})`) +
      ` across ${s.dates} day${s.dates === 1 ? "" : "s"}, ` +
      `${s.gamesPassed} PASS.`,
  );
  out.push("");
  out.push(
    `- Handicap: ${s.handicapRecord.wins}-${s.handicapRecord.losses}` +
      (s.handicapProfitTotal === null
        ? ""
        : ` · **${fmtUnits(s.handicapProfitTotal)} units** after the cut` +
          (s.handicapRoi === null
            ? ""
            : ` (ROI ${fmtPct(s.handicapRoi)} per bet)`)),
  );
  if (s.handicapProfitAssessment) {
    const p = s.handicapProfitAssessment;
    // The significance claim is about the MONEY (mean realized profit vs
    // zero), because partial 半-line stakes make a win-rate test lie. Three
    // outcomes on purpose: "provably losing" must never render as
    // "inconclusive".
    out.push(
      `- Significance (P&L): ${fmtPct(p.meanProfit)} per bet over ${p.n} stakes — ` +
        `z ${p.z.toFixed(2)}, ` +
        (p.verdict === "ahead"
          ? "**statistically ahead of break-even**"
          : p.verdict === "behind"
            ? "**statistically BEHIND break-even — the book is losing**"
            : "**not yet distinguishable from luck**"),
    );
  }
  if (s.handicapAssessment) {
    const a = s.handicapAssessment;
    out.push(
      `- Hit rate: ${pct(a.rate)} over ${a.n} bets ` +
        `(95% CI ${pct(a.ci95.lo)}–${pct(a.ci95.hi)}) vs ${pct(a.breakEven)} ` +
        `full-unit break-even`,
    );
  }
  out.push(
    `- Total: ${marketRecordLabel(s.totalRecord, TOTAL_MARKET_NEVER_QUOTED)}`,
  );
  if (s.meanBrier !== null) {
    out.push(
      `- Mean Brier: ${s.meanBrier} (0.25 = coin flip, lower is better)`,
    );
  }
  if (s.statedMean !== null && s.actualRate !== null) {
    const gap = s.actualRate - s.statedMean;
    out.push(
      `- Calibration: says ${pct(s.statedMean)}, actually ${pct(s.actualRate)} — ` +
        `${gap >= 0 ? "under" : "over"}confident by ${Math.abs(gap * 100).toFixed(1)}pt`,
    );
  }
  if (s.handicapCalibration) {
    const h = s.handicapCalibration;
    out.push(
      `- Handicap calibration: says ${pct(h.statedMean)}, actually ` +
        `${pct(h.actualRate)} over ${h.n} bet${h.n === 1 ? "" : "s"} ` +
        `(Brier ${h.meanBrier})`,
    );
  }
  if (s.totalCalibration) {
    const t = s.totalCalibration;
    out.push(
      `- Total calibration: says ${pct(t.statedMean)}, actually ` +
        `${pct(t.actualRate)} over ${t.n} bet${t.n === 1 ? "" : "s"} ` +
        `(Brier ${t.meanBrier})`,
    );
  }
  if (s.meanMarginError !== null) {
    out.push(`- Mean margin error: ${s.meanMarginError} runs`);
  }
  if (s.meanTotalError !== null) {
    out.push(`- Mean total error: ${s.meanTotalError} runs`);
  }
  out.push(
    `- Learned shrink (core/tail) — moneyline ${calibration.shrink}/${calibration.tailShrink}, ` +
      `handicap ${calibration.handicapShrink}/${calibration.handicapTailShrink}, ` +
      `total ${calibration.totalShrink}/${calibration.totalTailShrink} ` +
      `(${calibration.gamesSettled} games)`,
  );
  out.push("");

  if (s.gamesSettled < 30) {
    out.push(
      `> Only ${s.gamesSettled} settled pick(s) so far — far too few to judge. ` +
        `Watch the trend; wait for ~50+ before changing anything.`,
    );
    out.push("");
  }

  if (s.handicapBuckets.length > 0) {
    out.push("## Calibration by band (handicap)");
    out.push("");
    out.push(
      "_The headline gap can sit near zero while one band runs hot and " +
        "another collapses — this is the table that shows it._",
    );
    out.push("");
    for (const b of s.handicapBuckets) out.push(bucketLine(b));
    out.push("");
  }

  // The winner market gets its own curve only when it says something the
  // handicap curve does not — with every line quoted at 0 the two books are
  // the same bets, and printing the table twice would bury the signal.
  if (
    s.winnerBuckets.length > 0 &&
    JSON.stringify(s.winnerBuckets) !== JSON.stringify(s.handicapBuckets)
  ) {
    out.push("## Calibration by band (winner)");
    out.push("");
    for (const b of s.winnerBuckets) out.push(bucketLine(b));
    out.push("");
  }

  if (s.byConfidence.length > 0) {
    out.push("## By confidence");
    out.push("");
    for (const c of s.byConfidence) {
      out.push(
        `- ${c.confidence}: ${c.wins}-${c.losses} (${c.rate === null ? "no decided bet" : pct(c.rate)}, ` +
          `${fmtUnits(c.profit)} units, n=${c.n})`,
      );
    }
    out.push("");
  }

  out.push("## By day");
  out.push("");
  for (const d of [...s.perDate].reverse()) {
    out.push(
      `- ${d.date}: ${d.winnerRecord.wins}-${d.winnerRecord.losses}` +
        ` (${d.settled} pick${d.settled === 1 ? "" : "s"}, ${d.passed} PASS` +
        (d.meanBrier === null ? ")" : `, Brier ${d.meanBrier})`),
    );
  }
  return out.join("\n") + "\n";
}

export function auditToMarkdown(a: AuditReport): string {
  const out: string[] = [];
  out.push("# HandiEdge — standing audit");
  out.push("");
  out.push(`_Generated ${a.generatedAt} over ${a.daysAudited} day(s)._`);
  out.push("");

  out.push("## S-3 / B-2 — Integrity");
  out.push("");
  // Lock findings have their own section, with the margins that explain them;
  // repeating them here said the same thing twice and made a lock problem
  // read as an integrity problem.
  const elsewhere = new Set(["late_lock", "tight_lock_margin"]);
  const findings = a.issues.filter((i) => !elsewhere.has(i.code));
  if (findings.length === 0) {
    out.push(
      "✅ No issues: independent re-score matches the official history, " +
        "every overdue slate is settled, all handicap notations resolve, " +
        "and the learning counters reconcile.",
    );
  } else {
    for (const i of findings) {
      out.push(`- ${i.severity === "error" ? "❌" : "⚠️"} \`${i.code}\` ${i.detail}`);
    }
  }
  out.push("");

  out.push("## S-4 — Lock discipline");
  out.push("");
  const withMargin = a.lockMargins.filter((m) => m.marginMinutes !== null);
  // "Actionable" is the same test the exit code applies: recent, and judged
  // by the deadline rule now in force. Grading the headline on ALL history
  // instead kept this section permanently ❌ over July slates that cannot
  // recur while the job itself passed — a red the reader learns to skip.
  const actionable = withMargin.filter((m) => m.recent && m.currentRule);
  const late = actionable.filter((m) => m.late);
  const tight = actionable.filter((m) => m.tight);
  const onTime = actionable.filter((m) => !m.late);
  const minOnTime = onTime.length
    ? Math.min(...onTime.map((m) => m.marginMinutes!))
    : null;
  out.push(
    `${late.length === 0 ? (tight.length === 0 ? "✅" : "⚠️") : "❌"} ` +
      `${late.length} of ${actionable.length} slates in the last ${LOCK_WINDOW_DAYS} days locked late` +
      ` (each judged by the deadline in force when it locked).` +
      (minOnTime === null
        ? ""
        : ` Tightest on-time margin: ${minOnTime} minutes.`),
  );
  for (const m of late) {
    out.push(`- ❌ ${m.date}: locked ${Math.abs(m.marginMinutes!)} min AFTER the deadline`);
  }
  // Erosion, before it becomes an incident: anything inside the warning
  // threshold is called out as such rather than shown as a bare number.
  for (const m of tight) {
    out.push(
      `- ⚠️ ${m.date}: only +${m.marginMinutes} min of headroom (under ${LOCK_MARGIN_WARN_MINUTES})`,
    );
  }
  // The five tightest remaining ON-TIME margins, so the trend is visible even
  // in a clean week.
  const tightest = [...onTime]
    .filter((m) => !m.tight)
    .sort((x, y) => x.marginMinutes! - y.marginMinutes!)
    .slice(0, 5);
  for (const m of tightest) {
    out.push(`- ${m.date}: +${m.marginMinutes} min`);
  }
  // Everything else stays on the record — it just does not pretend to be
  // something this week can fix.
  const archived = withMargin.filter((m) => m.late && !actionable.includes(m));
  if (archived.length > 0) {
    out.push(
      `- 🗄️ ${archived.length} older or superseded-rule slate(s) locked late, kept for the record: ` +
        archived
          .map((m) => `${m.date} (${Math.abs(m.marginMinutes!)} min)`)
          .join(", "),
    );
  }
  out.push("");

  out.push("## A-1 — Distribution validity");
  out.push("");
  if (!a.distribution) {
    out.push("_Fewer than 10 scored games — not enough to check the spread._");
  } else {
    const d = a.distribution;
    const varRatio = d.empiricalMarginVariance / d.modelMarginVariance;
    out.push(
      `- Margin residual variance: empirical ${d.empiricalMarginVariance} vs model ${d.modelMarginVariance} ` +
        `(ratio ${varRatio.toFixed(2)}) over ${d.n} games. ` +
        `The residual folds in mean-estimation error on top of scoring ` +
        `variance, so modestly above 1.0 is expected; a ratio well above ` +
        `~1.3 says the simulator's spread is still too narrow, well below ` +
        `1.0 says too wide.`,
    );
    out.push(
      `- Same-game run correlation: empirical ${d.empiricalRunCorrelation} vs model ${d.modelRunCorrelation}`,
    );
    out.push(`- Mean |margin error|: ${d.meanMarginError} runs`);
  }
  out.push("");

  out.push("## A-4 — Input-data health");
  out.push("");
  if (a.flagRates.length === 0) {
    out.push("_No data-quality flags recorded._");
  } else {
    for (const f of a.flagRates) {
      out.push(
        `- \`${f.flag}\`: ${f.games} games (${(f.rate * 100).toFixed(1)}%)`,
      );
    }
  }
  out.push("");

  out.push("## A-2 — Real-line machinery (offline proof)");
  out.push("");
  const lp = a.lineProof;
  if (lp.failures.length === 0) {
    out.push(
      `✅ Every quotable line settles correctly: ${lp.notations.length} notations ` +
        `(0.1–2.9 and 0半–2半9) × both quoted sides × margins ` +
        `${lp.margins[0]}…${lp.margins[lp.margins.length - 1]} = ${lp.cases} settled cases ` +
        `(${lp.backed.home} backing home, ${lp.backed.away} backing away), ` +
        `${lp.checks} property checks, all passing.`,
    );
    out.push("");
    out.push(
      "_Each case goes through the production path — `decide()` prices the " +
        "line, `settle()` books it — and is checked against the notation " +
        "alone: shares sum to 1, profit = 0.9·win − loss inside [−1, 0.9], " +
        "backing the other side mirrors it exactly, a better margin never " +
        "pays less, the 分 ladder matches, and the pick's label names the " +
        "side the money actually followed._",
    );
  } else {
    out.push(
      `❌ ${lp.failures.length} of ${lp.checks} property checks FAILED across ` +
        `${lp.cases} settled cases — the split-stake machinery is wrong, and ` +
        `every finding is listed under S-3 above.`,
    );
  }
  // Every whole number's ladder is the same ladder shifted, so one family is
  // shown and all of them are proved.
  const shownLadder = lp.ladder.filter((r) => r.notation.startsWith("1半"));
  if (shownLadder.length > 0) {
    out.push("");
    out.push(
      "The 分 ladder, as this build settles it — the giving side winning by " +
        "exactly the whole number, which is the only margin where a 半 line " +
        "splits. The 0半 and 2半 families are the same ladder one run over, " +
        "and are proved with it:",
    );
    out.push("");
    out.push("| line | margin | win share | push share | units |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const row of shownLadder) {
      out.push(
        `| 〈${row.notation}〉 | +${row.margin} | ${row.win} | ${row.push} | ${fmtUnits(row.profit)} |`,
      );
    }
  }
  out.push("");

  out.push("## A-2 — Real-line settlements (hand-check these)");
  out.push("");
  if (a.realLines.length === 0) {
    out.push(
      "_No bet on a non-zero line has settled yet. Our own arithmetic is " +
        "proved above; what a real settlement still adds is the BOOK's — " +
        "that it splits stakes and pays part-pushes the way this build " +
        "assumes. The first entries here are the ones to verify by hand " +
        "against the book's own statement._",
    );
  } else {
    out.push(
      "_Each row shows the whole arithmetic: the line as quoted, the final " +
        "margin from the backed side, how the stake split, and the units " +
        "that fell out. Check the first ones against the book's statement; " +
        "the audit already verifies the shares sum to 1, that " +
        "profit = 0.9·win − loss, and that it agrees with what settlement " +
        "recorded._",
    );
    out.push("");
    for (const r of a.realLines) {
      const parts = r.parts
        .map((p) => `${p.line > 0 ? "+" : ""}${p.line}×${p.weight}`)
        .join(" ");
      out.push(
        `- ${r.date} ${r.game} — backed **${r.backed}** (quoted 〈${r.quoted}〉), ` +
          `margin ${r.margin > 0 ? "+" : ""}${r.margin}`,
      );
      out.push(
        `  - stake on ${parts} → win ${r.win} / push ${r.push} / loss ${r.loss} ` +
          `→ **${fmtUnits(r.profit)} units** after the ${r.commission * 100}% cut` +
          (r.storedProfit === null
            ? ""
            : ` (settlement recorded ${fmtUnits(r.storedProfit)})`),
      );
    }
  }
  out.push("");

  out.push("## A-5 / A-2 — Watched cohorts");
  out.push("");
  out.push(
    "_Cohorts deliberately left without their own correction; judge at n≈50 " +
      "per cohort. Real-line rows are the A-2 readiness tripwire — the day " +
      "they stop reading n=0, cross-check those settlements by hand._",
  );
  out.push("");
  for (const c of a.cohorts) {
    out.push(
      `- ${c.cohort}: ` +
        (c.n === 0
          ? "n=0"
          : `${c.wins}-${c.losses} (${((c.hitRate ?? 0) * 100).toFixed(1)}%, ${fmtUnits(c.profit)} units, n=${c.n})`),
    );
  }
  return out.join("\n") + "\n";
}
