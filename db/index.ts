import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Config } from "@/lib/config";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = {
  db: Db;
  driver: "pg" | "pglite";
  /** Cheap liveness probe used by /api/health/ready. */
  ping(): Promise<void>;
  close(): Promise<void>;
};

/**
 * One factory, two drivers:
 *  - "pg":     node-postgres -> Supabase (Supavisor transaction pooler) or Docker Postgres.
 *  - "pglite": embedded Postgres (WASM) -> free, offline, zero install.
 * Drivers are imported lazily so production never loads PGlite and `next build` never connects.
 */
export async function createDb(config: Config): Promise<DbHandle> {
  if (config.dbDriver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { drizzle } = await import("drizzle-orm/pglite");
    if (!config.pgliteDir.includes("://")) (await import("node:fs")).mkdirSync(config.pgliteDir, { recursive: true });
    const client = await PGlite.create(config.pgliteDir, { extensions: { vector } });
    const db = drizzle({ client, schema }) as unknown as Db;
    return {
      db,
      driver: "pglite",
      ping: async () => void (await client.query("select 1")),
      close: () => client.close(),
    };
  }

  if (!config.databaseUrl) throw new Error("DATABASE_URL is required when DB_DRIVER=pg");
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...(config.dbSsl === "no-verify" ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  pool.on("error", (e) => console.error("pg pool error", e.message));
  const db = drizzle(pool, { schema }) as unknown as Db;
  return {
    db,
    driver: "pg",
    ping: async () => void (await pool.query("select 1")),
    close: () => pool.end(),
  };
}

/** Both drivers return `{ rows }` from db.execute(). */
export function rowsOf<T>(res: unknown): T[] {
  return ((res as { rows?: T[] }).rows ?? []) as T[];
}
