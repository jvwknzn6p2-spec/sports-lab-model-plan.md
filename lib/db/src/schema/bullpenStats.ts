import {
  pgTable,
  serial,
  integer,
  real,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * A team's season relief-pitching (bullpen) aggregate plus FIP-family metrics
 * and the most recent workload signals used for fatigue adjustment.
 */
export const bullpenStatsTable = pgTable(
  "bullpen_stats",
  {
    id: serial("id").primaryKey(),
    teamMlbId: integer("team_mlb_id").notNull(),
    season: integer("season").notNull(),

    // Counting stats (relief aggregate).
    outs: integer("outs").notNull(),
    battersFaced: integer("batters_faced"),
    strikeOuts: integer("strike_outs").notNull(),
    baseOnBalls: integer("base_on_balls").notNull(),
    hitByPitch: integer("hit_by_pitch"),
    homeRuns: integer("home_runs").notNull(),
    hits: integer("hits"),
    earnedRuns: integer("earned_runs"),
    runs: integer("runs"),

    // Derived metrics.
    fip: real("fip"),
    xfip: real("xfip"),
    fipMinus: real("fip_minus"),
    era: real("era"),
    whip: real("whip"),
    k9: real("k9"),
    bb9: real("bb9"),

    // Recent-workload / availability signals (fatigue model inputs).
    last3DaysIp: real("last_3_days_ip"),
    unavailableKeyArms: integer("unavailable_key_arms"),

    constantsSeason: integer("constants_season"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("bullpen_stats_uq").on(t.teamMlbId, t.season)],
);

export const insertBullpenStatsSchema = createInsertSchema(
  bullpenStatsTable,
).omit({
  id: true,
});
export type InsertBullpenStats = z.infer<typeof insertBullpenStatsSchema>;
export type BullpenStats = typeof bullpenStatsTable.$inferSelect;
