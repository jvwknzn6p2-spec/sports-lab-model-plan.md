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

/** Pitcher identity, keyed by the stable MLB person id. */
export const pitchersTable = pgTable(
  "pitchers",
  {
    id: serial("id").primaryKey(),
    mlbPersonId: integer("mlb_person_id").notNull(),
    fullName: text("full_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("pitchers_mlb_person_id_uq").on(t.mlbPersonId)],
);

export const insertPitcherSchema = createInsertSchema(pitchersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPitcher = z.infer<typeof insertPitcherSchema>;
export type Pitcher = typeof pitchersTable.$inferSelect;
