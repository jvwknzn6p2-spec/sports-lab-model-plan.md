/** Paths, the canonical feature order, and run-context resolution. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(HERE, "..");

export const PATHS = {
  fixtures: join(PKG_ROOT, "fixtures"),
  out: join(PKG_ROOT, "out"),
  models: join(PKG_ROOT, "models"),
} as const;

/** Canonical feature vector order — training and inference must agree. */
export const FEATURE_ORDER = [
  "home_starter_era",
  "home_starter_whip",
  "home_starter_k9",
  "away_starter_era",
  "away_starter_whip",
  "away_starter_k9",
  "home_bat_runs_pg",
  "away_bat_runs_pg",
  "home_bullpen_era",
  "away_bullpen_era",
  "home_form_l10",
  "away_form_l10",
  "park_factor",
  "temp_f",
  "wind_signed",
] as const;

export type FeatureName = (typeof FEATURE_ORDER)[number];

export function outPath(...parts: string[]): string {
  return join(PATHS.out, ...parts);
}
export function fixturePath(...parts: string[]): string {
  return join(PATHS.fixtures, ...parts);
}
export function modelPath(...parts: string[]): string {
  return join(PATHS.models, ...parts);
}
