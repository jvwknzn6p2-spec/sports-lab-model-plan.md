/**
 * Deterministic generator for the recorded training-history fixture.
 * Writes fixtures/history.json with a genuine learnable signal so the logistic
 * model trains to a realistic AUC. It is a *fixture* standing in for a real
 * historical export (the live feed is blocked in this sandbox); replace the file
 * with a real export and retrain — the schema is identical.
 *
 *   pnpm --filter @workspace/handiedge exec tsx tools/make-history.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../src/util/rng.js";
import { FEATURE_ORDER } from "../src/config.js";

const rng = mulberry32(20260725);

function normal(mean: number, sd: number): number {
  // Box–Muller.
  const u = Math.max(1e-9, rng());
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function poisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

const LEAGUE_RUNS_PG = 4.5;
const LEAGUE_ERA = 4.2;
const HOME_FIELD_RUNS = 0.15;

function expectedRuns(bat: number, oppEra: number, oppPen: number, park: number, wind: number): number {
  const oppPitch = 0.65 * oppEra + 0.35 * oppPen;
  let base = 0.5 * bat + 0.5 * ((LEAGUE_RUNS_PG * oppPitch) / LEAGUE_ERA);
  base *= park;
  base *= 1 + 0.01 * wind;
  return Math.max(0.05, base);
}

const N = 2000;
const rows: Record<string, number>[] = [];
for (let i = 0; i < N; i++) {
  const eraH = clamp(normal(4.0, 1.15), 2.0, 6.5);
  const eraA = clamp(normal(4.0, 1.15), 2.0, 6.5);
  const f: Record<string, number> = {
    home_starter_era: eraH,
    home_starter_whip: clamp(1.0 + (eraH - 4) * 0.09 + normal(0, 0.04), 0.9, 1.7),
    home_starter_k9: clamp(normal(8.5, 1.6), 5, 13),
    away_starter_era: eraA,
    away_starter_whip: clamp(1.0 + (eraA - 4) * 0.09 + normal(0, 0.04), 0.9, 1.7),
    away_starter_k9: clamp(normal(8.5, 1.6), 5, 13),
    home_bat_runs_pg: clamp(normal(4.5, 0.8), 3, 6.5),
    away_bat_runs_pg: clamp(normal(4.5, 0.8), 3, 6.5),
    home_bullpen_era: clamp(normal(4.0, 0.85), 2.5, 6),
    away_bullpen_era: clamp(normal(4.0, 0.85), 2.5, 6),
    home_form_l10: clamp(normal(0.5, 0.14), 0.2, 0.8),
    away_form_l10: clamp(normal(0.5, 0.14), 0.2, 0.8),
    park_factor: clamp(normal(1.0, 0.08), 0.85, 1.2),
    temp_f: clamp(normal(72, 12), 45, 100),
    wind_signed: clamp(normal(0, 6), -15, 15),
  };
  let homeExp =
    expectedRuns(f.home_bat_runs_pg!, f.away_starter_era!, f.away_bullpen_era!, f.park_factor!, f.wind_signed!) +
    HOME_FIELD_RUNS;
  let awayExp = expectedRuns(
    f.away_bat_runs_pg!,
    f.home_starter_era!,
    f.home_bullpen_era!,
    f.park_factor!,
    f.wind_signed!,
  );
  homeExp *= 1 + 0.1 * (f.home_form_l10! - 0.5);
  awayExp *= 1 + 0.1 * (f.away_form_l10! - 0.5);
  const hs = poisson(homeExp);
  const as = poisson(awayExp);
  const homeWin = hs > as ? 1 : hs < as ? 0 : rng() < 0.5 ? 1 : 0;
  const row: Record<string, number> = {};
  for (const k of FEATURE_ORDER) row[k] = Number(f[k]!.toFixed(3));
  row.home_win = homeWin;
  rows.push(row);
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "history.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedBy: "make-history", n: N, games: rows }), "utf-8");
console.log(`wrote ${rows.length} rows → ${out}`);
