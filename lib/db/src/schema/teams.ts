import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Canonical team identity, keyed by the stable MLB team id. */
export const teamsTable = pgTable(
  "teams",
  {
    id: serial("id").primaryKey(),
    mlbTeamId: integer("mlb_team_id").notNull(),
    name: text("name").notNull(),
    abbreviation: text("abbreviation"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("teams_mlb_team_id_uq").on(t.mlbTeamId)],
);

export const insertTeamSchema = createInsertSchema(teamsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTeam = z.infer<typeof insertTeamSchema>;
export type Team = typeof teamsTable.$inferSelect;
