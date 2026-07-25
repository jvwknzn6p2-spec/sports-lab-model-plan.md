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
 * A team's season batting line plus derived wOBA-centric metrics.
 * Offense is ranked by wOBA / wRC+, not batting average or raw runs.
 */
export const teamBattingStatsTable = pgTable(
  "team_batting_stats",
  {
    id: serial("id").primaryKey(),
    teamMlbId: integer("team_mlb_id").notNull(),
    season: integer("season").notNull(),
    gamesPlayed: integer("games_played"),

    // Counting stats.
    plateAppearances: integer("plate_appearances"),
    atBats: integer("at_bats").notNull(),
    hits: integer("hits").notNull(),
    doubles: integer("doubles").notNull(),
    triples: integer("triples").notNull(),
    homeRuns: integer("home_runs").notNull(),
    baseOnBalls: integer("base_on_balls").notNull(),
    intentionalWalks: integer("intentional_walks"),
    hitByPitch: integer("hit_by_pitch"),
    sacFlies: integer("sac_flies"),
    strikeOuts: integer("strike_outs"),
    stolenBases: integer("stolen_bases"),
    caughtStealing: integer("caught_stealing"),

    // Derived metrics.
    avg: real("avg"),
    obp: real("obp"),
    slg: real("slg"),
    ops: real("ops"),
    iso: real("iso"),
    woba: real("woba"),
    wraa: real("wraa"),
    wrc: real("wrc"),
    wrcPlus: real("wrc_plus"),
    kPct: real("k_pct"),
    bbPct: real("bb_pct"),
    babip: real("babip"),

    constantsSeason: integer("constants_season"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("team_batting_uq").on(t.teamMlbId, t.season)],
);

export const insertTeamBattingStatsSchema = createInsertSchema(
  teamBattingStatsTable,
).omit({ id: true });
export type InsertTeamBattingStats = z.infer<
  typeof insertTeamBattingStatsSchema
>;
export type TeamBattingStats = typeof teamBattingStatsTable.$inferSelect;
