import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// PostgreSQL 18 ships uuidv7(): time-ordered UUIDs, so B-tree inserts stay
// append-mostly (far better index locality than random uuidv4).
const pk = () => uuid("id").primaryKey().default(sql`uuidv7()`);

const tz = (name: string) => timestamp(name, { withTimezone: true });

const timestamps = {
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
};

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled", "completed"]);
export const bookingStatus = pgEnum("booking_status", [
  "pending", // seats held, awaiting payment
  "confirmed",
  "cancelled",
  "expired", // hold timed out
  "refunded",
]);
export const paymentStatus = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);

/* -------------------------------------------------------------------------- */
/* Authentication (Auth.js / next-auth v5 + @auth/drizzle-adapter)            */
/*                                                                            */
/* The adapter finds columns by their JS PROPERTY names (emailVerified,       */
/* sessionToken, providerAccountId, access_token, ...), so those names must   */
/* not change. The database column names are ours to choose. Extra columns    */
/* (status, deletedAt, ...) are fine as long as they are nullable or have a   */
/* default, because the adapter never writes them.                            */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  "users",
  {
    id: pk(),
    name: varchar("name", { length: 255 }), // OAuth profiles may omit it
    email: varchar("email", { length: 320 }).notNull(),
    emailVerified: tz("email_verified"),
    image: text("image"),
    // Only used if you later add the Credentials provider (which forces JWT sessions).
    passwordHash: text("password_hash"),
    status: userStatus("status").notNull().default("active"),
    lastLoginAt: tz("last_login_at"),
    deletedAt: tz("deleted_at"), // soft delete; enforced in the signIn callback
    ...timestamps,
  },
  (t) => [
    // Case-insensitive unique email among non-deleted users.
    uniqueIndex("users_email_lower_uq")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// One row per linked OAuth provider identity.
export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 32 }).notNull(), // "oauth" | "oidc" | "email" | "webauthn"
    provider: varchar("provider", { length: 64 }).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 255 }).notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"), // unix seconds, as Auth.js stores it
    token_type: varchar("token_type", { length: 32 }),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_idx").on(t.userId),
  ],
);

// Database sessions. NOTE: Auth.js stores sessionToken as-is (it is the cookie value).
export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expires: tz("expires").notNull(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expires), // for cleanup jobs
  ],
);

// Only used by the Email (magic link) provider.
export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: varchar("identifier", { length: 320 }).notNull(),
    token: text("token").notNull(),
    expires: tz("expires").notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/* -------------------------------------------------------------------------- */
/* Authorization (RBAC): users -> user_roles -> roles -> roles_permissions -> */
/* permissions                                                                */
/* -------------------------------------------------------------------------- */

export const roles = pgTable("roles", {
  id: pk(),
  name: varchar("name", { length: 64 }).notNull().unique(), // admin | organizer | attendee
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false), // protect built-in roles from deletion in app code
  ...timestamps,
});

export const permissions = pgTable("permissions", {
  id: pk(),
  // "<resource>:<action>[:<scope>]", e.g. "event:create", "booking:read:any"
  key: varchar("key", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const rolesPermissions = pgTable(
  "roles_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index("roles_permissions_permission_idx").on(t.permissionId),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    grantedAt: tz("granted_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index("user_roles_role_idx").on(t.roleId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

export const venues = pgTable(
  "venues",
  {
    id: pk(),
    name: varchar("name", { length: 255 }).notNull(),
    addressLine: varchar("address_line", { length: 255 }),
    city: varchar("city", { length: 120 }).notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(), // ISO 3166-1 alpha-2
    timezone: varchar("timezone", { length: 64 }).notNull(), // IANA, e.g. "Africa/Nairobi"
    deletedAt: tz("deleted_at"),
    ...timestamps,
  },
  (t) => [index("venues_city_idx").on(t.countryCode, t.city)],
);

export const events = pgTable(
  "events",
  {
    id: pk(),
    organizerId: uuid("organizer_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    venueId: uuid("venue_id").notNull().references(() => venues.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 280 }).notNull().unique(),
    description: text("description"),
    status: eventStatus("status").notNull().default("draft"),
    // Stored as UTC instants. `timezone` is the venue's IANA zone captured at
    // creation, so local display stays correct across DST changes.
    startsAt: tz("starts_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    timezone: varchar("timezone", { length: 64 }).notNull(),
    deletedAt: tz("deleted_at"),
    // Generated full-text column (title weighted above description).
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B')`,
    ),
    ...timestamps,
  },
  (t) => [
    check("events_end_after_start", sql`${t.endsAt} > ${t.startsAt}`),
    index("events_search_gin").using("gin", t.searchVector),
    // Partial index: the public listing only ever reads live, published events.
    index("events_published_starts_idx")
      .on(t.startsAt)
      .where(sql`${t.status} = 'published' and ${t.deletedAt} is null`),
    index("events_organizer_idx").on(t.organizerId),
    index("events_venue_idx").on(t.venueId),
  ],
);

export const ticketTypes = pgTable(
  "ticket_types",
  {
    id: pk(),
    eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(), // "General", "VIP"
    priceCents: integer("price_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(), // ISO 4217
    quantityTotal: integer("quantity_total").notNull(),
    quantitySold: integer("quantity_sold").notNull().default(0), // includes held (pending) seats
    maxPerBooking: integer("max_per_booking").notNull().default(10),
    saleStartsAt: tz("sale_starts_at"),
    saleEndsAt: tz("sale_ends_at"),
    version: integer("version").notNull().default(0), // optimistic locking
    deletedAt: tz("deleted_at"),
    ...timestamps,
  },
  (t) => [
    check("ticket_types_price_nonneg", sql`${t.priceCents} >= 0`),
    check("ticket_types_total_nonneg", sql`${t.quantityTotal} >= 0`),
    // The database itself refuses to oversell, even if application code has a bug.
    check("ticket_types_no_oversell", sql`${t.quantitySold} >= 0 and ${t.quantitySold} <= ${t.quantityTotal}`),
    uniqueIndex("ticket_types_event_name_uq").on(t.eventId, t.name).where(sql`${t.deletedAt} is null`),
    index("ticket_types_event_idx").on(t.eventId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Bookings and payments                                                      */
/* -------------------------------------------------------------------------- */

export const bookings = pgTable(
  "bookings",
  {
    id: pk(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    eventId: uuid("event_id").notNull().references(() => events.id, { onDelete: "restrict" }),
    status: bookingStatus("status").notNull().default("pending"),
    // Client-generated UUID. A retried request hits this constraint instead of double-booking.
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    totalCents: integer("total_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    holdExpiresAt: tz("hold_expires_at"), // pending bookings release seats after this
    confirmedAt: tz("confirmed_at"),
    cancelledAt: tz("cancelled_at"),
    version: integer("version").notNull().default(0),
    ...timestamps, // financial rows are never deleted; state lives in `status`
  },
  (t) => [
    check("bookings_total_nonneg", sql`${t.totalCents} >= 0`),
    index("bookings_user_idx").on(t.userId, t.createdAt),
    index("bookings_event_status_idx").on(t.eventId, t.status),
    // Sweeper job: find expired holds quickly.
    index("bookings_pending_expiry_idx").on(t.holdExpiresAt).where(sql`${t.status} = 'pending'`),
  ],
);

export const bookingItems = pgTable(
  "booking_items",
  {
    id: pk(),
    bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "restrict" }),
    ticketTypeId: uuid("ticket_type_id").notNull().references(() => ticketTypes.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(), // price snapshot at purchase time
  },
  (t) => [
    check("booking_items_qty_positive", sql`${t.quantity} > 0`),
    check("booking_items_price_nonneg", sql`${t.unitPriceCents} >= 0`),
    uniqueIndex("booking_items_booking_ticket_uq").on(t.bookingId, t.ticketTypeId),
    index("booking_items_ticket_type_idx").on(t.ticketTypeId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: pk(),
    bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 32 }).notNull(), // "stripe", "mpesa", ...
    providerPaymentId: varchar("provider_payment_id", { length: 255 }),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    amountCents: integer("amount_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    failureReason: text("failure_reason"),
    ...timestamps,
  },
  (t) => [
    check("payments_amount_nonneg", sql`${t.amountCents} >= 0`),
    uniqueIndex("payments_provider_ref_uq").on(t.provider, t.providerPaymentId),
    index("payments_booking_idx").on(t.bookingId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Audit trail (populated by triggers in db/hardening.sql; append-only)       */
/* -------------------------------------------------------------------------- */

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    // Deliberately NO foreign key: the audit trail must outlive the users it describes.
    actorId: uuid("actor_id"),
    action: varchar("action", { length: 16 }).notNull(), // INSERT | UPDATE | DELETE
    entityTable: varchar("entity_table", { length: 64 }).notNull(),
    entityId: text("entity_id"),
    oldData: jsonb("old_data"),
    newData: jsonb("new_data"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityTable, t.entityId, t.createdAt),
    index("audit_actor_idx").on(t.actorId, t.createdAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Relations (for db.query.* relational queries)                              */
/* -------------------------------------------------------------------------- */

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles, { relationName: "user_roles_user" }),
  accounts: many(accounts),
  sessions: many(sessions),
  bookings: many(bookings),
  organizedEvents: many(events),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  userRoles: many(userRoles),
  rolesPermissions: many(rolesPermissions),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolesPermissions: many(rolesPermissions),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id], relationName: "user_roles_user" }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));

export const rolesPermissionsRelations = relations(rolesPermissions, ({ one }) => ({
  role: one(roles, { fields: [rolesPermissions.roleId], references: [roles.id] }),
  permission: one(permissions, { fields: [rolesPermissions.permissionId], references: [permissions.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const venuesRelations = relations(venues, ({ many }) => ({ events: many(events) }));

export const eventsRelations = relations(events, ({ one, many }) => ({
  organizer: one(users, { fields: [events.organizerId], references: [users.id] }),
  venue: one(venues, { fields: [events.venueId], references: [venues.id] }),
  ticketTypes: many(ticketTypes),
  bookings: many(bookings),
}));

export const ticketTypesRelations = relations(ticketTypes, ({ one, many }) => ({
  event: one(events, { fields: [ticketTypes.eventId], references: [events.id] }),
  bookingItems: many(bookingItems),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  user: one(users, { fields: [bookings.userId], references: [users.id] }),
  event: one(events, { fields: [bookings.eventId], references: [events.id] }),
  items: many(bookingItems),
  payments: many(payments),
}));

export const bookingItemsRelations = relations(bookingItems, ({ one }) => ({
  booking: one(bookings, { fields: [bookingItems.bookingId], references: [bookings.id] }),
  ticketType: one(ticketTypes, { fields: [bookingItems.ticketTypeId], references: [ticketTypes.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, { fields: [payments.bookingId], references: [bookings.id] }),
}));

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Event = typeof events.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;