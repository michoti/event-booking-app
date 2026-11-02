import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { getUserAccess } from "@/lib/authz";

// Lazy config (a function): the DB is only touched per request, never at
// import time, so `next build` works without DATABASE_URL.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  adapter: DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Database sessions: revocable server-side, and role changes apply immediately.
  // (Adding the Credentials provider would force strategy: "jwt".)
  session: { strategy: "database", maxAge: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  providers: [
    // Reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET and AUTH_GITHUB_ID / AUTH_GITHUB_SECRET automatically.
    Google,
    GitHub,
  ],
  trustHost: true, // we run behind Docker / a reverse proxy
  callbacks: {
    // Block suspended or soft-deleted accounts. For OAuth this runs BEFORE the
    // user row exists, and `user.id` is the provider's id (not our uuid), so we
    // look the account up by email instead.
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false; // we require an email address
      const [row] = await getDb()
        .select({ status: users.status, deletedAt: users.deletedAt })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      if (!row) return true; // first sign-in: the adapter creates the user next
      return row.status === "active" && row.deletedAt === null;
    },
    // With database sessions, `user` is the DB row. Attach id, roles, permissions.
    async session({ session, user }) {
      const access = await getUserAccess(user.id);
      session.user.id = user.id;
      session.user.roles = access.roles;
      session.user.permissions = access.permissions;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id) {
        await getDb().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      }
    },
  },
}));