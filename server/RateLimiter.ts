import { DurableObject } from 'cloudflare:workers';

/**
 * Per-caller request budgets.
 *
 * One object per client IP rather than one global object: a single limiter
 * would put every request in the game through one lock, which is a worse
 * bottleneck than the abuse it prevents. Sharding by caller means an object
 * only ever serialises that caller's own traffic.
 *
 * Fixed windows, not token buckets. A token bucket is better behaved under
 * sustained load, but these limits exist to stop scripted abuse rather than to
 * smooth traffic, and a window that a human will never reach is easier to
 * reason about and to explain in a 429.
 */

export interface RateLimitRule {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * Deliberately loose. Carrier-grade NAT and school or office networks put many
 * genuine players behind one address, so every limit here is far above what a
 * person can produce and far below what a script does in a second.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  // Account creation is the one that matters: unbounded registration grows
  // storage forever and floods the leaderboard with rows nobody played.
  register: { limit: 10, windowMs: 60 * 60_000 },
  create: { limit: 30, windowMs: 10 * 60_000 },
  quickmatch: { limit: 60, windowMs: 10 * 60_000 },
  addFriend: { limit: 30, windowMs: 60 * 60_000 },
  rename: { limit: 20, windowMs: 60 * 60_000 },
  // Cosmetic and cheap, but it writes to storage and rewrites a leaderboard
  // row, so it is not free to hammer.
  setAvatar: { limit: 60, windowMs: 60 * 60_000 },
  // Generous enough for a group of friends organising a session, tight enough
  // that the invite channel cannot be used to hammer somebody's list.
  invite: { limit: 60, windowMs: 10 * 60_000 },
  // Generous on purpose: the reconnect ladder makes up to nine attempts on a
  // bad connection, and cutting someone off mid-match for having poor wifi
  // would be a far worse bug than the abuse this guards against.
  socket: { limit: 120, windowMs: 5 * 60_000 },
};

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const { bucket, limit, windowMs } = (await request.json()) as {
      bucket: string;
      limit: number;
      windowMs: number;
    };

    const now = Date.now();
    const key = `w:${bucket}`;
    const current = await this.ctx.storage.get<Window>(key);

    if (!current || now >= current.resetAt) {
      await this.ctx.storage.put(key, { count: 1, resetAt: now + windowMs });
      return Response.json({ allowed: true, remaining: limit - 1, retryAfter: 0 });
    }

    if (current.count >= limit) {
      return Response.json({
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      });
    }

    current.count += 1;
    await this.ctx.storage.put(key, current);
    return Response.json({ allowed: true, remaining: limit - current.count, retryAfter: 0 });
  }
}
