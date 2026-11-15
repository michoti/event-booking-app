import type { ICache } from "../ports";

/** Fixed-window limiter (60s) on top of KV/memory. Fails open: a cache outage must not block bookings. */
export class RateLimiter {
  constructor(
    private cache: ICache,
    private perMinute: number,
  ) {}

  async hit(key: string): Promise<{ allowed: boolean; remaining: number }> {
    try {
      const window = Math.floor(Date.now() / 60_000);
      const n = await this.cache.incr(`rl:${key}:${window}`, 70);
      return { allowed: n <= this.perMinute, remaining: Math.max(0, this.perMinute - n) };
    } catch {
      return { allowed: true, remaining: this.perMinute };
    }
  }
}
