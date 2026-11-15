import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/server";
import { accounts, sessions, users, verificationTokens } from "@/db/schema";
import { getUserAccess } from "@/lib/authz";

// Lazy, async config: the database is touched per request, never at import time,
// so `next build` works with no DATABASE_URL.
export const { handlers, auth, signIn, signOut } = NextAuth(async () => ({
  adapter: DrizzleAdapter(await getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  // Database sessions: revocable server-side, role changes apply immediately.
  session: { strategy: "database" as const, maxAge: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  providers: [Google, GitHub], // read AUTH_GOOGLE_ID/SECRET and AUTH_GITHUB_ID/SECRET
  pages: { signIn: "/signin" },
  trustHost: true,
  callbacks: {
    // Block suspended or soft-deleted accounts (runs before the user row exists on first OAuth sign-in).
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const db = await getDb();
      const [row] = await db
        .select({ status: users.status, deletedAt: users.deletedAt })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);
      if (!row) return true;
      return row.status === "active" && row.deletedAt === null;
    },
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
        const db = await getDb();
        await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      }
    },
  },
}));

/** Degraded mode: if the database is down, browsing continues as a guest instead of crashing the layout. */
export async function safeAuth() {
  try {
    return await auth();
  } catch {
    return null;
  }
}
