import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * UNLOGGED table (no WAL: fast writes, truncated after a crash). It is created in
 * drizzle/0003_holds_and_cron.sql, NOT by drizzle-kit, which cannot express UNLOGGED.
 * This definition exists only for typed queries. Loss-tolerant data only: carts are a
 * convenience; authoritative inventory lives in the logged `ticket_types`/`bookings` tables.
 */
export const ephemeralCarts = pgTable("ephemeral_carts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  eventId: uuid("event_id").notNull(),
  items: jsonb("items").$type<{ ticketTypeId: string; quantity: number }[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
