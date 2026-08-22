/**
 * Locate the committed HandiEdge data directory (lib/sports-data/data).
 *
 * The server reads the same files the GitHub Actions pipeline commits —
 * prediction locks, history, calibration — so it has no database dependency
 * for the read-only endpoints. `SPORTS_DATA_DIR` overrides for deployments
 * where the data lives elsewhere; otherwise walk up from cwd to the
 * workspace root (pnpm-workspace.yaml), which works both for `pnpm run dev`
 * (cwd = artifacts/api-server) and a bundle started from the repo root.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type League = "mlb" | "npb";

/** Store directory name per league — mirrors engine/league.ts. */
const DIR_BY_LEAGUE: Record<League, string> = {
  mlb: "data",
  npb: "data-npb",
};

export function sportsDataDir(league: League = "mlb"): string {
  const override = process.env.SPORTS_DATA_DIR;
  // The override names the MLB store; the NPB store is its sibling.
  if (override) {
    return league === "mlb"
      ? resolve(override)
      : join(resolve(override), "..", DIR_BY_LEAGUE.npb);
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return join(dir, "lib", "sports-data", DIR_BY_LEAGUE[league]);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Cannot locate lib/sports-data/data (no pnpm-workspace.yaml above " +
          `${process.cwd()}). Set SPORTS_DATA_DIR.`,
      );
    }
    dir = parent;
  }
}
