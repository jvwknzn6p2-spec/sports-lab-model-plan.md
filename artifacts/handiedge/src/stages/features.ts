/**
 * Stage 2 — Feature Engine.
 * Deterministic transform from an intake record to the canonical feature row.
 */
import { FEATURE_ORDER } from "../config.js";
import { featureRowSchema, type FeatureRow, type IntakeGame } from "../schemas.js";

const WIND_SIGN: Record<string, number> = { out: 1, in: -1, cross: 0, calm: 0 };

export function windSigned(windDir: string | null, windMph: number | null): number {
  if (!windDir || windMph == null) return 0;
  return (WIND_SIGN[windDir] ?? 0) * windMph;
}

export function buildFeatures(game: IntakeGame): FeatureRow {
  const s = game.schedule;
  const hp = s.homePitcher;
  const ap = s.awayPitcher;
  const features: Record<string, number> = {
    home_starter_era: hp?.era ?? 4.5,
    home_starter_whip: hp?.whip ?? 1.3,
    home_starter_k9: hp?.kPer9 ?? 8.0,
    away_starter_era: ap?.era ?? 4.5,
    away_starter_whip: ap?.whip ?? 1.3,
    away_starter_k9: ap?.kPer9 ?? 8.0,
    home_bat_runs_pg: s.homeBatRunsPg,
    away_bat_runs_pg: s.awayBatRunsPg,
    home_bullpen_era: s.homeBullpenEra,
    away_bullpen_era: s.awayBullpenEra,
    home_form_l10: s.homeFormL10,
    away_form_l10: s.awayFormL10,
    park_factor: s.parkFactor,
    temp_f: s.tempF ?? 72,
    wind_signed: windSigned(s.windDir, s.windMph),
  };
  for (const name of FEATURE_ORDER) {
    if (!(name in features)) throw new Error(`feature builder missing ${name}`);
  }
  return featureRowSchema.parse({ gameId: game.gameId, features });
}

export function toVector(features: Record<string, number>): number[] {
  return FEATURE_ORDER.map((name) => {
    const v = features[name];
    if (v == null) throw new Error(`missing feature ${name}`);
    return v;
  });
}
