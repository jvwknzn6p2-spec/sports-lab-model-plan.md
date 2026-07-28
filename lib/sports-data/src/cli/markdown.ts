/**
 * Phone-readable Markdown renderings of the daily output.
 *
 * The CLI console report assumes a wide terminal. When HandiEdge runs
 * unattended (GitHub Actions) the deliverable is a file you open on a phone,
 * so these renderers keep lines short, lead with the pick, and avoid wide
 * tables that force horizontal scrolling on a narrow screen.
 */

import type { CalibrationState, GamePrediction } from "../engine/decision";
import { fmtPct, fmtUnits, rankByValue } from "../engine/decision";
import type { HistorySummary } from "../engine/report";
import type { SettlementReport } from "../engine/settle";
import { pickTrackerBlock } from "./pick-tracker";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

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
    `_Shrink: moneyline ${calibration.shrink}, handicap ` +
      `${calibration.handicapShrink}, total ${calibration.totalShrink} · ` +
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
    `- Self-learning — moneyline ${r.calibrationBefore.shrink} → ${r.calibrationAfter.shrink}, ` +
      `handicap ${r.calibrationBefore.handicapShrink} → ${r.calibrationAfter.handicapShrink}, ` +
      `total ${r.calibrationBefore.totalShrink} → ${r.calibrationAfter.totalShrink}`,
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
  out.push(`- Handicap: ${s.handicapRecord.wins}-${s.handicapRecord.losses}`);
  out.push(`- Total: ${s.totalRecord.wins}-${s.totalRecord.losses}`);
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
        `${pct(h.actualRate)} over ${h.n} bet${h.n === 1 ? "" : "s"}`,
    );
  }
  if (s.totalCalibration) {
    const t = s.totalCalibration;
    out.push(
      `- Total calibration: says ${pct(t.statedMean)}, actually ` +
        `${pct(t.actualRate)} over ${t.n} bet${t.n === 1 ? "" : "s"}`,
    );
  }
  if (s.meanMarginError !== null) {
    out.push(`- Mean margin error: ${s.meanMarginError} runs`);
  }
  if (s.meanTotalError !== null) {
    out.push(`- Mean total error: ${s.meanTotalError} runs`);
  }
  out.push(
    `- Learned shrink — moneyline ${calibration.shrink}, handicap ` +
      `${calibration.handicapShrink}, total ${calibration.totalShrink} ` +
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
