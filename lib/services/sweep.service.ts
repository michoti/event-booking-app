import { sql } from "drizzle-orm";
import { rowsOf, type Db } from "@/db";
import type { IClock } from "../ports";

/** Calls the SQL sweeper. Same function pg_cron runs every 30s; this is the HTTP/CLI/lazy fallback path. */
export class SweepService {
  constructor(
    private db: Db,
    private clock: IClock,
  ) {}

  async run(): Promise<{ releasedBookings: number; purgedCarts: number }> {
    const res = await this.db.execute(sql`select sweep_expired(${this.clock.now().toISOString()}::timestamptz) as out`);
    const raw = rowsOf<{ out: unknown }>(res)[0]?.out;
    const out = (typeof raw === "string" ? JSON.parse(raw) : raw) as { released_bookings: number; purged_carts: number };
    return { releasedBookings: out.released_bookings, purgedCarts: out.purged_carts };
  }
}
