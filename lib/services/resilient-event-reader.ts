import { FALLBACK_EVENTS } from "../fallback/events";
import type { EventDetail, EventSummary, ICache, IEventReader, IEventSource, ILogger, Listing } from "../ports";

const KEY = (limit: number) => `events:list:${limit}`;
const STALE_TTL = 60 * 60 * 24;

/**
 * Decorator over the database source. Fallback chain for the public listing:
 *   live database  ->  last good copy in KV/memory  ->  bundled static listing.
 * Pages show a "booking paused" banner whenever source !== "live".
 */
export class ResilientEventReader implements IEventReader {
  constructor(
    private source: IEventSource,
    private cache: ICache,
    private log: ILogger,
  ) {}

  async list(limit = 24): Promise<Listing> {
    try {
      const events = await this.source.listEvents(limit);
      await this.cache.set(KEY(limit), events, STALE_TTL).catch(() => {});
      return { events, source: "live" };
    } catch (e) {
      this.log.error({ err: (e as Error).message }, "event listing: database unavailable");
    }
    const stale = await this.cache.get<EventSummary[]>(KEY(limit)).catch(() => null);
    if (stale?.length) {
      return { events: stale.map((s) => ({ ...s, startsAt: new Date(s.startsAt) })), source: "cache" };
    }
    return { events: FALLBACK_EVENTS, source: "fallback" };
  }

  /** No stale copy on purpose: a detail page can start a reservation, so it must be live or fail (error boundary). */
  getBySlug(slug: string): Promise<EventDetail | null> {
    return this.source.getBySlug(slug);
  }
}
