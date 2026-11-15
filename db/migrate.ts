import { join } from "node:path";
import type { DbHandle } from "./index";

export const MIGRATIONS_FOLDER = join(process.cwd(), "drizzle");

/** Same SQL files, either driver. Idempotent: drizzle tracks applied migrations. */
export async function runMigrations(handle: DbHandle, folder = MIGRATIONS_FOLDER) {
  if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: folder });
  } else {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(handle.db as never, { migrationsFolder: folder });
  }
}
