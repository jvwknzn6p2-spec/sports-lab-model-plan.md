/**
 * Section 6 of the plan: the human-readable daily report.
 *
 * Two rules shape the formatting:
 *   - Scannable at a glance. Ranked S first, best bets pulled out on their own.
 *   - Honest about uncertainty. Flags are printed, not hidden; low-confidence
 *     picks are visibly low-confidence; and a game with missing data says which
 *     input is missing rather than looking identical to a clean one.
 */

import { MLB_SCHEDULE_TIME_ZONE } from "../core/dates";
import type {
  AnalysisReport,
  BetEvaluation,
  DailyPredictions,
  GamePrediction,
} from "../core/types";

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}`;
}

function americanString(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function localTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "time TBD";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: MLB_SCHEDULE_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(parsed));
}

function bestBet(bets: BetEvaluation[]): BetEvaluation | null {
  const positive = bets.filter((b) => b.positiveEv);
  if (positive.length === 0) return null;
  return positive.reduce((best, bet) => (bet.edge > best.edge ? bet : best));
}

function valueLines(prediction: GamePrediction): string[] {
  if (prediction.bets.length === 0) {
    return ["             no market prices available — no EV computed"];
  }
  const ranked = [...prediction.bets].sort((a, b) => b.edge - a.edge).slice(0, 4);
  return ranked.map((bet, index) => {
    const label = index === 0 ? "Value:      " : "            ";
    const verdict = bet.positiveEv
      ? `EV positive ✅  (half-Kelly ${pct(bet.kellyFraction / 2, 2)})`
      : bet.expectedValue > 0
        ? "EV positive but inside the noise"
        : "no edge";
    return (
      `${label} ${bet.selection.padEnd(14)} ${americanString(bet.americanOdds).padStart(6)}  ` +
      `${signedPct(bet.edge).padStart(6)}% edge  ${verdict}`
    );
  });
}

export function formatGameCard(prediction: GamePrediction): string {
  const { home, away, calibrated, simulation } = prediction;
  const lines: string[] = [];

  lines.push(`${away.name} @ ${home.name} — ${localTime(prediction.gameTimeUtc)}`);
  lines.push(
    `Confidence: ${prediction.confidence.rank}   ` +
      `(score ${prediction.confidence.score.toFixed(0)}/100, ` +
      `data ${pct(prediction.quality.completeness, 0)} complete)`,
  );
  lines.push("");

  // Label, model output, verdict — the verdict column is aligned so the picks
  // read down the page in a single scan.
  const row = (label: string, body: string, verdict: string): string =>
    `${label.padEnd(12)} ${body.padEnd(34)} → ${verdict}`;

  const pick = prediction.moneylinePick;
  lines.push(
    row(
      "Moneyline:",
      `${home.abbrev} ${pct(calibrated.homeWinProbability)}  |  ` +
        `${away.abbrev} ${pct(calibrated.awayWinProbability)}`,
      `Pick: ${pick.team.abbrev} ${pct(pick.probability)}`,
    ),
  );

  const homeFavoured = calibrated.homeWinProbability >= 0.5;
  const coverProb = homeFavoured ? simulation.homeCoversMinus1p5 : 1 - simulation.awayCoversPlus1p5;
  lines.push(
    row(
      "Run line:",
      `${homeFavoured ? home.abbrev : away.abbrev} -1.5 covers ${pct(coverProb)}`,
      coverProb >= 0.5 ? "leans cover" : "leans no cover",
    ),
  );

  const bookTotal = prediction.context.odds?.total?.line ?? null;
  const overBet = prediction.bets.find(
    (b) => b.grading.kind === "total" && b.grading.direction === "over",
  );
  lines.push(
    row(
      "Total:",
      `Predicted ${calibrated.predictedTotal.toFixed(1)}` +
        `${bookTotal !== null ? `  (Line ${bookTotal})` : "  (no line)"}`,
      overBet
        ? `${overBet.modelProbability >= 0.5 ? "OVER" : "UNDER"} ${pct(
            Math.max(overBet.modelProbability, 1 - overBet.modelProbability),
          )}`
        : "no market",
    ),
  );
  lines.push(
    `             range ${simulation.percentiles.total["p10"]?.toFixed(0)}-` +
      `${simulation.percentiles.total["p90"]?.toFixed(0)} runs (10th-90th pct), ` +
      `extras ${pct(simulation.extraInningsRate)}`,
  );
  lines.push("");
  lines.push(...valueLines(prediction));
  lines.push("");

  if (prediction.keyFactors.length > 0) {
    lines.push(`Key factors: ${prediction.keyFactors[0]}`);
    for (const factor of prediction.keyFactors.slice(1)) {
      lines.push(`             ${factor}`);
    }
  }

  const flags = [
    ...prediction.confidence.caps,
    ...prediction.issues
      .filter((issue) => issue.severity !== "info")
      .map((issue) => `${issue.field}: ${issue.message}`),
  ];
  if (flags.length === 0) {
    lines.push("Flags:       none");
  } else {
    lines.push(`Flags:       ${flags[0]}`);
    for (const flag of flags.slice(1)) lines.push(`             ${flag}`);
  }

  return lines.join("\n");
}

export function formatDailyReport(daily: DailyPredictions): string {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push(`AI SPORTS LAB — ${daily.sport} predictions for ${daily.date}`);
  lines.push(
    `model ${daily.modelVersion}  |  calibration ${daily.calibrationVersion}  |  ` +
      `generated ${daily.generatedAt}`,
  );
  lines.push("=".repeat(78));
  lines.push("");

  if (daily.games.length === 0) {
    lines.push("No games to predict.");
    if (daily.skipped.length > 0) {
      lines.push("");
      for (const skip of daily.skipped) lines.push(`  skipped ${skip.matchup}: ${skip.reason}`);
    }
    return lines.join("\n");
  }

  // --- best bets ------------------------------------------------------------
  const bestBets = daily.games
    .filter((g) => g.confidence.rank === "S" || g.confidence.rank === "A")
    .flatMap((g) => {
      const bet = bestBet(g.bets);
      return bet ? [{ game: g, bet }] : [];
    })
    .sort((a, b) => b.bet.edge - a.bet.edge);

  lines.push("BEST BETS  (positive EV, rank S or A only)");
  lines.push("-".repeat(78));
  if (bestBets.length === 0) {
    lines.push("  None today. That is a normal outcome — the market is usually right.");
  } else {
    for (const { game, bet } of bestBets) {
      lines.push(
        `  [${game.confidence.rank}] ${bet.selection.padEnd(14)} ` +
          `${americanString(bet.americanOdds).padStart(6)}  ` +
          `${signedPct(bet.edge).padStart(6)}% edge  ` +
          `EV ${bet.expectedValue >= 0 ? "+" : ""}${bet.expectedValue.toFixed(3)}u  ` +
          `— ${game.away.abbrev} @ ${game.home.abbrev}`,
      );
    }
  }
  lines.push("");

  // --- all games ------------------------------------------------------------
  lines.push("ALL GAMES  (highest confidence first)");
  lines.push("-".repeat(78));
  lines.push("");
  for (const game of daily.games) {
    lines.push(formatGameCard(game));
    lines.push("");
    lines.push("-".repeat(78));
    lines.push("");
  }

  // --- data problems --------------------------------------------------------
  const problems = daily.games.filter(
    (g) => g.quality.missing.length > 0 || g.confidence.caps.length > 0,
  );
  lines.push("DATA NOTES");
  lines.push("-".repeat(78));
  if (problems.length === 0) {
    lines.push("  All games had complete inputs.");
  } else {
    for (const game of problems) {
      lines.push(
        `  ${game.away.abbrev} @ ${game.home.abbrev} — rank ${game.confidence.rank}; ` +
          `missing: ${game.quality.missing.join(", ") || "nothing"}`,
      );
    }
  }
  for (const skip of daily.skipped) {
    lines.push(`  skipped ${skip.matchup}: ${skip.reason}`);
  }
  lines.push("");
  lines.push(
    "Reminder: this is decision support, not advice, and not a profit forecast. " +
      "A 60% pick loses 4 times in 10.",
  );

  return lines.join("\n");
}

export function formatAnalysis(report: AnalysisReport): string {
  const lines: string[] = [];
  const n = report.games;
  lines.push("=".repeat(78));
  lines.push(`ACCURACY REVIEW — ${report.from} to ${report.to}  (${n} graded games)`);
  lines.push("=".repeat(78));
  lines.push("");

  if (n === 0) {
    lines.push("Nothing graded in this range yet.");
    lines.push("Run `score` for a date that has both predictions and final results.");
    return lines.join("\n");
  }

  const ml = report.moneyline;
  lines.push("MONEYLINE");
  lines.push(
    `  win rate ${ml.accuracy !== null ? pct(ml.accuracy) : "n/a"}   ` +
      `Brier ${ml.brier?.toFixed(4) ?? "n/a"}   log loss ${ml.logLoss?.toFixed(4) ?? "n/a"}`,
  );
  lines.push(
    `  probability bias ${ml.bias !== null ? `${signedPct(ml.bias)} points` : "n/a"} ` +
      `(positive = we over-rate the home team)`,
  );
  lines.push("");
  lines.push("  reliability — do the games we call X% actually win X%?");
  for (const bin of ml.bins) {
    if (bin.count === 0) continue;
    const width = Math.round(bin.count / Math.max(1, Math.ceil(n / 40)));
    lines.push(
      `    ${pct(bin.lower, 0).padStart(4)}-${pct(bin.upper, 0).padEnd(4)} ` +
        `n=${String(bin.count).padStart(4)}  predicted ${pct(bin.predictedMean)}  ` +
        `observed ${pct(bin.observedRate)}  ${"#".repeat(Math.min(30, width))}`,
    );
  }
  lines.push("");

  lines.push("TOTALS");
  lines.push(
    `  mean absolute error ${report.totals.meanAbsoluteError?.toFixed(2) ?? "n/a"} runs   ` +
      `bias ${report.totals.bias !== null ? `${report.totals.bias >= 0 ? "+" : ""}${report.totals.bias.toFixed(2)}` : "n/a"} runs ` +
      `(positive = we predict too many)`,
  );
  lines.push(
    `  actual total went over our prediction ${
      report.totals.overRate !== null ? pct(report.totals.overRate) : "n/a"
    } of the time`,
  );
  lines.push("");

  lines.push("EXTRA INNINGS");
  lines.push(
    `  simulated ${
      report.extraInnings.predictedRate !== null ? pct(report.extraInnings.predictedRate, 2) : "n/a"
    }   observed ${
      report.extraInnings.observedRate !== null ? pct(report.extraInnings.observedRate, 2) : "n/a"
    }`,
  );
  lines.push("");

  lines.push("BETTING  (flat 1 unit on positive-EV bets only)");
  lines.push(
    `  ${report.betting.positiveEvBets} flagged, ${report.betting.unitsStaked} settled, ` +
      `profit ${report.betting.profitUnits >= 0 ? "+" : ""}${report.betting.profitUnits.toFixed(2)}u, ` +
      `ROI ${report.betting.roi !== null ? pct(report.betting.roi) : "n/a"}`,
  );
  lines.push("");

  lines.push("BY CONFIDENCE RANK  (S should beat A should beat B...)");
  for (const rank of report.byRank) {
    if (rank.games === 0) continue;
    lines.push(
      `  ${rank.rank}  n=${String(rank.games).padStart(4)}  ` +
        `win rate ${rank.moneylineAccuracy !== null ? pct(rank.moneylineAccuracy) : "n/a"}  ` +
        `Brier ${rank.brier?.toFixed(4) ?? "n/a"}  ` +
        `bets ${String(rank.unitsStaked).padStart(3)}  ` +
        `ROI ${rank.roi !== null ? pct(rank.roi) : "n/a"}`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("WARNINGS");
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }

  return lines.join("\n");
}
