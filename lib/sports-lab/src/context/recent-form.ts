/**
 * Step 3 — Recent form.
 *
 * Derives a team's recent-form summary from its most recent completed games.
 * Pure and deterministic: Steps 1–2 supply the raw results, this collapses
 * them into the per-team summary the model and validation layers consume.
 *
 * Plan note (Section 7): recent form over 10–15 games is noisy. This module
 * reports `sampleSize` honestly so the validation layer can flag thin samples
 * rather than presenting a 3-game average as if it were stable.
 */
import type { GameResult, TeamRecentForm } from "../schemas";

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * @param teamId    Team the form belongs to.
 * @param results   Completed games in any order (newest-first not required).
 * @param window    Desired lookback length (e.g. 10 or 15).
 * @param fetchedAt ISO timestamp recording when this was computed.
 */
export function computeRecentForm(
  teamId: string,
  results: readonly GameResult[],
  window: number,
  fetchedAt: string,
): TeamRecentForm {
  // Take the most recent `window` games by date (descending), then keep chrono.
  const recent = [...results]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, window);

  const wins = recent.filter((r) => r.won).length;

  return {
    teamId,
    sampleSize: recent.length,
    window,
    wins,
    losses: recent.length - wins,
    runsScoredPerGame: mean(recent.map((r) => r.runsScored)),
    runsAllowedPerGame: mean(recent.map((r) => r.runsAllowed)),
    fetchedAt,
  };
}
