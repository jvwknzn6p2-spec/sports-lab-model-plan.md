import {
  pgTable,
  serial,
  integer,
  text,
  real,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** One scheduled game (the backbone: one prediction per row). */
export const gamesTable = pgTable(
  "games",
  {
    id: serial("id").primaryKey(),
    gamePk: integer("game_pk").notNull(),
    season: integer("season").notNull(),
    gameDate: timestamp("game_date", { withTimezone: true }),
    status: text("status"),
    homeTeamMlbId: integer("home_team_mlb_id").notNull(),
    awayTeamMlbId: integer("away_team_mlb_id").notNull(),
    homeProbablePitcherMlbId: integer("home_probable_pitcher_mlb_id"),
    awayProbablePitcherMlbId: integer("away_probable_pitcher_mlb_id"),
    venueId: integer("venue_id"),
    venueName: text("venue_name"),
    /** One-year park factor (100 = neutral). */
    parkFactor: real("park_factor"),
    /** When this schedule row was pulled (plan: timestamp everything). */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("games_game_pk_uq").on(t.gamePk)],
);

export const insertGameSchema = createInsertSchema(gamesTable).omit({
  id: true,
});
export type InsertGame = z.infer<typeof insertGameSchema>;
export type Game = typeof gamesTable.$inferSelect;
