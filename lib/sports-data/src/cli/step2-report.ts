/**
 * Step-2 demo/report CLI.
 *
 * Runs the full Step-2 pipeline (schedule → starters/batting/bullpen features)
 * against the offline fixture slate and prints a FIP-forward report, so the
 * ingestion + feature layer can be exercised end-to-end without network access.
 *
 *   pnpm --filter @workspace/sports-data run step2:report
 *
 * With a live, reachable MLB API you would swap FixtureCoreDataSource for
 * MlbCoreDataSource(date) — the orchestrator code is identical.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { assembleDate, type GameCoreData, type TeamCoreData } from "../step2";
import {
  FixtureCoreDataSource,
  type FixtureBundle,
} from "../sources/fixture-source";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(here, "..", "..", "fixtures", "2024-slate.json");

function fmt(n: number | null, dp = 2): string {
  return n === null ? "  — " : n.toFixed(dp);
}

function teamBlock(side: "HOME" | "AWAY", t: TeamCoreData): string[] {
  const lines: string[] = [];
  const sp = t.starter;
  const bt = t.batting;
  const bp = t.bullpen;
  lines.push(`  ${side}: ${t.teamName ?? "?"}`);
  if (sp) {
    lines.push(
      `    SP ${sp.pitcherName ?? sp.pitcherId}: ` +
        `FIP ${fmt(sp.metrics.fip)}  xFIP ${fmt(sp.metrics.xfip)}  ` +
        `FIP- ${fmt(sp.metrics.fipMinus, 0)}  K-BB% ${fmt(sp.metrics.kMinusBbPct !== null ? sp.metrics.kMinusBbPct * 100 : null, 1)}%`,
    );
    lines.push(
      `       → projFIP ${fmt(sp.projectedFip)}  ` +
        `expRuns/9 ${fmt(sp.expectedRunsAllowedPer9)}  ` +
        `reliability ${fmt(sp.reliability)}  (ERA ref ${fmt(sp.metrics.era)})`,
    );
  } else {
    lines.push("    SP: (no data)");
  }
  if (bt) {
    lines.push(
      `    Bat: wOBA ${fmt(bt.metrics.woba, 3)}  wRC+ ${fmt(bt.metrics.wrcPlus, 0)}  ` +
        `ISO ${fmt(bt.metrics.iso, 3)}  → expRuns/G ${fmt(bt.expectedRunsPerGame)}`,
    );
  } else {
    lines.push("    Bat: (no data)");
  }
  if (bp) {
    lines.push(
      `    Pen: FIP ${fmt(bp.metrics.fip)}  projFIP ${fmt(bp.projectedFip)}  ` +
        `fatigue +${fmt(bp.fatiguePenalty)}  → expRuns/9 ${fmt(bp.expectedRunsAllowedPer9)}`,
    );
  } else {
    lines.push("    Pen: (no data)");
  }
  return lines;
}

function gameReport(g: GameCoreData): string {
  const out: string[] = [];
  out.push(
    `${g.away.teamName} @ ${g.home.teamName}  —  ${g.venue.name ?? "?"} ` +
      `(PF ${g.parkFactor})  [${g.complete ? "COMPLETE" : "INCOMPLETE"}]`,
  );
  out.push(...teamBlock("AWAY", g.away));
  out.push(...teamBlock("HOME", g.home));
  if (g.flags.length) {
    out.push("    Flags:");
    for (const f of g.flags) {
      out.push(`      [${f.severity}] ${f.code}: ${f.message}`);
    }
  } else {
    out.push("    Flags: none");
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const bundle = JSON.parse(
    await readFile(FIXTURE_PATH, "utf8"),
  ) as FixtureBundle;
  const source = new FixtureCoreDataSource(bundle);
  const games = await assembleDate(bundle.date, source, {
    season: bundle.season,
  });

  console.log("=".repeat(78));
  console.log(
    `AI Sports Lab — Step 2 core data (FIP-based)   date=${bundle.date} season=${bundle.season}`,
  );
  console.log("=".repeat(78));
  for (const g of games) {
    console.log("");
    console.log(gameReport(g));
  }
  console.log("");
  console.log("-".repeat(78));
  console.log(
    `Assembled ${games.length} game(s); ` +
      `${games.filter((g) => g.complete).length} complete. ` +
      `Pitchers ranked by FIP/xFIP, offense by wOBA/wRC+, bullpens fatigue-adjusted.`,
  );
}

main().catch((err) => {
  console.error("step2-report failed:", err);
  process.exitCode = 1;
});
