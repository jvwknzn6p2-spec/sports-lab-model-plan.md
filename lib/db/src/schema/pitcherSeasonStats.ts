import {
  pgTable,
  serial,
  integer,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A starting pitcher's season line plus the derived FIP-family metrics.
 *
 * Design note: run prevention is stored and ranked by FIP/xFIP/FIP-, not ERA.
 * ERA is kept only as `era` for reference. Counting stats are kept alongside the
 * derived rates so metrics can be recomputed if league constants are refreshed.
 */
export const pitcherSeasonStatsTable = pgTable(
  "pitcher_season_stats",
  {
    id: serial("id").primaryKey(),
    mlbPersonId: integer("mlb_person_id").notNull(),
    season: integer("season").notNull(),
    teamMlbId: integer("team_mlb_id"),

    // Counting stats (source of truth).
    outs: integer("outs").notNull(),
    battersFaced: integer("batters_faced"),
    strikeOuts: integer("strike_outs").notNull(),
    baseOnBalls: integer("base_on_balls").notNull(),
    hitByPitch: integer("hit_by_pitch"),
    homeRuns: integer("home_runs").notNull(),
    hits: integer("hits"),
    earnedRuns: integer("earned_runs"),
    runs: integer("runs"),

    // Derived defense-independent metrics.
    fip: real("fip"),
    xfip: real("xfip"),
    fipMinus: real("fip_minus"),
    kwera: real("kwera"),
    era: real("era"),
    whip: real("whip"),
    k9: real("k9"),
    bb9: real("bb9"),
    hr9: real("hr9"),
    kPct: real("k_pct"),
    bbPct: real("bb_pct"),
    kMinusBbPct: real("k_minus_bb_pct"),
    babip: real("babip"),
    lobPct: real("lob_pct"),

    /** Constants season actually applied (for auditing fallbacks). */
    constantsSeason: integer("constants_season"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("pitcher_season_uq").on(t.mlbPersonId, t.season)],
);

export const insertPitcherSeasonStatsSchema = createInsertSchema(
  pitcherSeasonStatsTable,
).omit({ id: true });
export type InsertPitcherSeasonStats = z.infer<
  typeof insertPitcherSeasonStatsSchema
>;
export type PitcherSeasonStats = typeof pitcherSeasonStatsTable.$inferSelect;
