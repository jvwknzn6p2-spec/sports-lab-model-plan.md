/**
 * Copy-paste block for the "Pick Tracker Pro" phone app.
 *
 * Pick Tracker Pro (a separate Lovable project owned by the same user) logs
 * predictions by parsing pasted text. Rather than retyping a slate into it by
 * hand, HandiEdge emits a block in exactly the shape its parser accepts, so the
 * daily routine is: open the report on the phone, copy this block, paste.
 *
 * The target parser (its `src/lib/tracker/parser.ts`) requires:
 *   - a header line containing the sport keyword and a YYYY-MM-DD date, which
 *     is how it assigns `sport` and `date` to every block that follows;
 *   - one numbered block per game (`1.` / `2.` …), the rest of that first line
 *     being the match name;
 *   - `ハンデ:` / `予想:` / `勝率:` fields — a block with none of these is
 *     skipped outright, and a block with no `予想` value is reported unparsed.
 *
 * Its rank thresholds (S- ≥65, A- ≥60, B- ≥55, C- ≥50) line up with the
 * decision engine's own S/A/B/C bands, so the fine rank it derives from the
 * win probability agrees with the confidence this engine assigned. We
 * therefore send the probability and let it derive the rank, rather than
 * sending a rank it might disagree with.
 *
 * PASS games are deliberately omitted: the tracker computes hit rates over
 * everything it stores, so logging a no-bet game would dilute the record.
 */

import type { GamePrediction } from "../engine/decision";
import { rankByValue } from "../engine/decision";

/** Fields the tracker reads, in the order its `pickAfter` regex expects. */
function gameBlock(index: number, p: GamePrediction): string[] {
  const lines: string[] = [];
  lines.push(`${index}. ${p.away} vs ${p.home}`);
  // Handicap line: fall back to the moneyline when no line was configured, so
  // the field is never blank (a blank field parses as an empty string).
  lines.push(`ハンデ: ${p.handicap.pick ?? "マネーライン"}`);
  lines.push(`予想: ${p.predictedWinner}`);
  lines.push(`勝率: ${(p.winProbability * 100).toFixed(1)}%`);
  if (p.total.pick && p.total.line !== null) {
    lines.push(
      `メモ: トータル ${p.total.pick} ${p.total.line} / ${p.reasons[0] ?? ""}`,
    );
  } else if (p.reasons.length > 0) {
    lines.push(`メモ: ${p.reasons[0]}`);
  }
  return lines;
}

/**
 * Render the day's picks as a Pick Tracker Pro paste block, or `null` when
 * there is nothing to log (an all-PASS day).
 */
export function pickTrackerBlock(
  date: string,
  predictions: GamePrediction[],
): string | null {
  // Numbered in recommendation order (best expected value first), so the paste
  // doubles as the 優先度 list rather than an arbitrary slate order. Shares
  // rankByValue with the Markdown report: numbering the two independently gave
  // two different "3." for the same slate.
  const picks = rankByValue(
    predictions.filter((p) => !p.pass && p.predictedWinner),
  );
  if (picks.length === 0) return null;

  // Header: the tracker reads `sport` from the first three lines and `date`
  // from the first YYYY-MM-DD anywhere in the text.
  const out: string[] = [`MLB ${date}`, ""];
  picks.forEach((p, i) => {
    out.push(...gameBlock(i + 1, p));
    out.push("");
  });
  return out.join("\n").trimEnd() + "\n";
}
