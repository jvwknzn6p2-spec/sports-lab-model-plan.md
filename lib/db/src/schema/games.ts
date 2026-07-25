import { pgTable, text, integer, boolean, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * One row per scheduled MLB game (model-plan.md build step 1).
 *
 * Keyed on MLB's `gamePk` rather than a synthetic id, because it is already
 * globally unique, stable across re-fetches, and — importantly — distinct for
 * each half of a doubleheader. A natural key of (date, home, away) would
 * collide there.
 *
 * The daily job upserts into this table, so re-running it is safe and picks up
 * late changes: a starter being announced, a postponement, a moved start time.
 */
export const gamesTable = pgTable(
  "games",
  {
    /** MLB's globally unique game id. */
    gamePk: integer("game_pk").primaryKey(),

    /** Human-readable key, e.g. `2026-07-25:LAA@HOU:g1`. */
    key: text("key").notNull(),

    /** Seed for the simulator. Stored so a prediction can always be reproduced. */
    seed: text("seed").notNull(),

    season: text("season").notNull(),
    gameType: text("game_type").notNull(),

    /** Scheduled first pitch, UTC. */
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),

    /** The calendar date MLB assigns the game. The natural query axis for a daily run. */
    officialDate: text("official_date").notNull(),

    status: text("status").notNull(),
    detailedState: text("detailed_state").notNull(),
    statusReason: text("status_reason"),

    homeTeamId: integer("home_team_id").notNull(),
    homeTeamName: text("home_team_name").notNull(),
    homeProbablePitcherId: integer("home_probable_pitcher_id"),
    homeProbablePitcherName: text("home_probable_pitcher_name"),
    homeScore: integer("home_score"),

    awayTeamId: integer("away_team_id").notNull(),
    awayTeamName: text("away_team_name").notNull(),
    awayProbablePitcherId: integer("away_probable_pitcher_id"),
    awayProbablePitcherName: text("away_probable_pitcher_name"),
    awayScore: integer("away_score"),

    venueId: integer("venue_id"),
    venueName: text("venue_name"),

    doubleHeader: text("double_header").notNull(),
    gameNumber: integer("game_number").notNull(),
    scheduledInnings: integer("scheduled_innings").notNull(),
    seriesDescription: text("series_description"),
    dayNight: text("day_night"),

    isPredictable: boolean("is_predictable").notNull(),

    /** Data-quality flags. Drives the confidence rank and the Data Auditor agent. */
    flags: jsonb("flags").$type<string[]>().notNull().default([]),

    /** When this row was first seen. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * When this row was last refreshed.
     *
     * The plan requires every pull to be timestamped (§3) so backtests can tell
     * what was actually known at prediction time, rather than accidentally
     * scoring the model against information it did not have.
     */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // The daily job's main query: "what is on today, and which are worth predicting".
    index("games_official_date_idx").on(table.officialDate),
    index("games_status_idx").on(table.status),
    index("games_start_time_idx").on(table.startTime),
  ],
);

export const insertGameSchema = createInsertSchema(gamesTable);
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;
