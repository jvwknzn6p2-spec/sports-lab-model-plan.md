/**
 * Runnable demo of the Step 9 review layer.
 *
 *   pnpm --filter @workspace/ai-review run demo
 *
 * Runs the sample slate through the review pipeline and prints a report-style
 * summary. Uses the offline heuristic provider by default; set ANTHROPIC_API_KEY
 * to exercise the full Claude-backed review.
 */

import { reviewSlate } from "./orchestrator.js";
import { defaultProvider } from "./provider.js";
import { SAMPLE_SLATE, SAMPLE_NOW } from "./sample-data.js";
import type { ReviewResult } from "./types.js";

function printResult(result: ReviewResult): void {
  const arrow =
    result.finalConfidence === result.originalConfidence
      ? result.finalConfidence
      : `${result.originalConfidence} → ${result.finalConfidence}`;
  console.log(`\n${result.gameId}  [confidence ${arrow}]`);
  for (const verdict of result.verdicts) {
    const mark = verdict.ok ? "ok" : "!!";
    console.log(
      `  ${mark} ${verdict.agent} (${verdict.source}): ${verdict.reasoning}`,
    );
  }
  if (result.warnings.length > 0) {
    console.log("  warnings:");
    for (const w of result.warnings) console.log(`    - ${w}`);
  } else {
    console.log("  warnings: none");
  }
}

async function main(): Promise<void> {
  const provider = defaultProvider();
  console.log(`AI Sports Lab — Step 9 review demo (provider: ${provider.kind})`);

  const results = await reviewSlate(SAMPLE_SLATE, {
    provider,
    now: SAMPLE_NOW,
  });

  for (const result of results) printResult(result);

  const bestBets = results.filter(
    (r) =>
      (r.finalConfidence === "S" || r.finalConfidence === "A") &&
      r.flags.every((f) => f.severity !== "critical"),
  );
  console.log(
    `\nBest bets (S/A after review): ${
      bestBets.length ? bestBets.map((r) => r.gameId).join(", ") : "none"
    }`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
