import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Lazy initialisation: importing this module must NOT require DATABASE_URL,
// because `next build` imports route modules without any runtime env present.
const g = globalThis as unknown as {
  __pgPool?: Pool;
  __drizzle?: NodePgDatabase<typeof schema>;
};

export function getPool(): Pool {
  if (!g.__pgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => console.error("pg pool error", err));
    g.__pgPool = pool;
  }
  return g.__pgPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!g.__drizzle) g.__drizzle = drizzle(getPool(), { schema });
  return g.__drizzle;
}