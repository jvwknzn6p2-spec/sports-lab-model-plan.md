import {
  type GameStatBundle,
  type PitcherSeasonStats,
  type TeamBattingStats,
  type TeamPitchingStats,
} from "./types";

/**
 * Lightweight plausibility checks for assembled stats ("verify the data looks
 * sane", plan Step 2). These do NOT judge whether a value is *missing* — that
 * is what `dataFlags` is for. They catch values that are present but obviously
 * wrong (out of a physically plausible range), e.g. an OBP above 1 or a
 * negative ERA, which usually signal a parsing or upstream error.
 *
 * Each issue is a human-readable string prefixed with its path, e.g.
 * `home.batting.obp=1.42 out of range [0, 1]`.
 */

interface Range {
  min: number;
  max: number;
}

const PLAUSIBLE = {
  era: { min: 0, max: 27 },
  whip: { min: 0, max: 5 },
  strikeoutsPer9: { min: 0, max: 25 },
  inningsPitched: { min: 0, max: 2000 },
  gamesStarted: { min: 0, max: 40 },
  saves: { min: 0, max: 70 },
  runs: { min: 0, max: 1200 },
  obp: { min: 0, max: 1 },
  slg: { min: 0, max: 4 },
  ops: { min: 0, max: 5 },
  avg: { min: 0, max: 1 },
} satisfies Record<string, Range>;

function checkRange(
  value: number | null,
  range: Range,
  path: string,
  issues: string[],
): void {
  if (value === null) return; // absence is a flag concern, not a sanity concern
  if (value < range.min || value > range.max) {
    issues.push(`${path}=${value} out of range [${range.min}, ${range.max}]`);
  }
}

export function checkPitcherSanity(p: PitcherSeasonStats, path: string): string[] {
  const issues: string[] = [];
  checkRange(p.era, PLAUSIBLE.era, `${path}.era`, issues);
  checkRange(p.whip, PLAUSIBLE.whip, `${path}.whip`, issues);
  checkRange(p.strikeoutsPer9, PLAUSIBLE.strikeoutsPer9, `${path}.strikeoutsPer9`, issues);
  checkRange(p.inningsPitched, PLAUSIBLE.inningsPitched, `${path}.inningsPitched`, issues);
  checkRange(p.gamesStarted, PLAUSIBLE.gamesStarted, `${path}.gamesStarted`, issues);
  return issues;
}

export function checkBattingSanity(b: TeamBattingStats, path: string): string[] {
  const issues: string[] = [];
  checkRange(b.runs, PLAUSIBLE.runs, `${path}.runs`, issues);
  checkRange(b.obp, PLAUSIBLE.obp, `${path}.obp`, issues);
  checkRange(b.slg, PLAUSIBLE.slg, `${path}.slg`, issues);
  checkRange(b.ops, PLAUSIBLE.ops, `${path}.ops`, issues);
  checkRange(b.avg, PLAUSIBLE.avg, `${path}.avg`, issues);
  return issues;
}

export function checkTeamPitchingSanity(t: TeamPitchingStats, path: string): string[] {
  const issues: string[] = [];
  checkRange(t.era, PLAUSIBLE.era, `${path}.era`, issues);
  checkRange(t.whip, PLAUSIBLE.whip, `${path}.whip`, issues);
  checkRange(t.strikeoutsPer9, PLAUSIBLE.strikeoutsPer9, `${path}.strikeoutsPer9`, issues);
  checkRange(t.inningsPitched, PLAUSIBLE.inningsPitched, `${path}.inningsPitched`, issues);
  checkRange(t.saves, PLAUSIBLE.saves, `${path}.saves`, issues);
  return issues;
}

/** Run every sanity check over a bundle. Empty array means nothing implausible. */
export function checkGameStatsSanity(bundle: GameStatBundle): string[] {
  const issues: string[] = [];
  for (const side of ["home", "away"] as const) {
    const s = bundle[side];
    issues.push(...checkBattingSanity(s.batting, `${side}.batting`));
    issues.push(...checkTeamPitchingSanity(s.pitchingStaff, `${side}.pitchingStaff`));
    if (s.probableStarter) {
      issues.push(...checkPitcherSanity(s.probableStarter, `${side}.probableStarter`));
    }
  }
  return issues;
}
